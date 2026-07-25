import { createHash } from "node:crypto"

/**
 * 停滞检测的证据层：一轮结束后拍快照，与上一轮 diff，回答「这轮有没有进展」。
 *
 * 这是「不达目的不放弃」的另一半 —— 无轮次上限的前提是停滞判定足够可靠。
 * 判定基于**证据**而非计数：
 *
 * 算进展（任一）：
 *   - 判据状态跃迁 fail|unknown → pass（最强信号）
 *   - 门禁状态跃迁 fail → pass
 *   - 完成任务数增加
 *   - 改了文件 **且** 错误签名不是一字不差地重复
 *   - 出现新的错误签名 —— 错误变了说明在推进，虽然还没成
 *
 * 明确不算进展：iteration/token 涨了、回复文本变了、计划措辞变了但结构签名
 *   没变、改了文件但错误原样重复（原地打转的最常见形态）。
 *
 * 负进展（pass → fail）单独报出 —— 修一个坏两个的回归必须让用户看见。
 */

/** 归一化错误文本后取签名：路径、行号、hex、时间戳都抹平。 */
export function errorSignature(text) {
  const normalized = String(text || "")
    .replace(/(?:[A-Za-z]:)?[\\/][\w.\\/-]+/g, "<path>")
    .replace(/:\d+(?::\d+)?/g, ":<n>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, "<ts>")
    .replace(/\b\d{10,13}\b/g, "<ts>")
    .trim()
    .slice(0, 160)
  if (!normalized) return ""
  return createHash("sha1").update(normalized).digest("hex").slice(0, 12)
}

/**
 * 拍一轮的快照。
 * @param {object} p
 * @param {object} p.verification verifyGoal 的结果（可 null）
 * @param {object} p.gateResult   runUsabilityGates 的结果（可 null）
 * @param {object} p.taskProgress
 * @param {Array}  p.fileChanges  [{path, addedLines, removedLines}]
 * @param {string} p.planSig      planSignature(stagePlan)
 * @param {number} p.maxStageIndexReached
 */
export function snapshotRound({
  verification = null, gateResult = null, taskProgress = {},
  fileChanges = [], planSig = "", maxStageIndexReached = 0
} = {}) {
  const criteria = {}
  if (verification) {
    for (const r of verification.results || []) criteria[r.id] = r.status
    for (const sub of verification.subGoals || []) {
      for (const r of sub.results || []) criteria[r.id] = r.status
    }
  }
  const gates = {}
  for (const [name, gate] of Object.entries(gateResult?.gates || {})) {
    gates[name] = gate?.status || "unknown"
  }
  const files = {}
  for (const change of fileChanges) {
    if (!change?.path) continue
    const prev = files[change.path] || { added: 0, removed: 0 }
    files[change.path] = {
      added: prev.added + (Number(change.addedLines ?? change.added) || 0),
      removed: prev.removed + (Number(change.removedLines ?? change.removed) || 0)
    }
  }
  const errorSignatures = [...new Set(
    Object.values(taskProgress)
      .filter((t) => t.status === "error" || t.status === "skipped")
      .map((t) => errorSignature(t.lastError))
      .filter(Boolean)
  )]
  const tasksCompleted = Object.values(taskProgress).filter((t) => t.status === "completed").length

  return { criteria, gates, files, errorSignatures, tasksCompleted, planSig, maxStageIndexReached }
}

const GOOD = new Set(["pass"])
const BAD = new Set(["fail", "unknown", "pending_manual"])

/**
 * @returns {{madeProgress: boolean, reason: string, signals: object}}
 */
export function diffSnapshots(prev, next) {
  if (!prev) {
    // 第一轮没有对比基准：有产出即算有进展
    const made = next.tasksCompleted > 0 || Object.keys(next.files).length > 0
    return {
      madeProgress: made,
      reason: made ? "首轮，有产出" : "首轮，无任何产出",
      signals: { firstRound: true }
    }
  }

  const criteriaAdvanced = []
  const criteriaRegressed = []
  for (const [id, status] of Object.entries(next.criteria)) {
    const before = prev.criteria[id]
    if (BAD.has(before) && GOOD.has(status)) criteriaAdvanced.push(id)
    if (GOOD.has(before) && BAD.has(status)) criteriaRegressed.push(id)
  }

  const gatesAdvanced = []
  const gatesRegressed = []
  for (const [name, status] of Object.entries(next.gates)) {
    const before = prev.gates[name]
    if (before === "fail" && (status === "pass" || status === "not_applicable")) gatesAdvanced.push(name)
    if ((before === "pass" || before === "not_applicable") && status === "fail") gatesRegressed.push(name)
  }

  const filesChanged = []
  for (const [file, counts] of Object.entries(next.files)) {
    const before = prev.files[file]
    if (!before || before.added !== counts.added || before.removed !== counts.removed) filesChanged.push(file)
  }

  const prevSigs = new Set(prev.errorSignatures)
  const newErrorSignatures = next.errorSignatures.filter((sig) => !prevSigs.has(sig))
  const repeatedErrorSignatures = next.errorSignatures.filter((sig) => prevSigs.has(sig))

  const tasksCompletedDelta = next.tasksCompleted - prev.tasksCompleted
  const stageAdvanced = next.maxStageIndexReached > prev.maxStageIndexReached
  const planChanged = Boolean(prev.planSig && next.planSig && prev.planSig !== next.planSig)

  const signals = {
    criteriaAdvanced, criteriaRegressed, gatesAdvanced, gatesRegressed,
    filesChanged, newErrorSignatures, repeatedErrorSignatures,
    tasksCompletedDelta, stageAdvanced, planChanged
  }

  // 强进展信号
  if (criteriaAdvanced.length) {
    return { madeProgress: true, reason: `判据 ${criteriaAdvanced.join(", ")} 由未过转为通过`, signals }
  }
  if (gatesAdvanced.length) {
    return { madeProgress: true, reason: `门禁 ${gatesAdvanced.join(", ")} 由失败转为通过`, signals }
  }
  if (tasksCompletedDelta > 0) {
    return { madeProgress: true, reason: `新完成 ${tasksCompletedDelta} 个任务`, signals }
  }
  if (stageAdvanced) {
    return { madeProgress: true, reason: "推进到了更后面的 stage", signals }
  }
  if (filesChanged.length && !repeatedErrorSignatures.length) {
    return { madeProgress: true, reason: `${filesChanged.length} 个文件有新变更且错误没有原样重复`, signals }
  }
  if (newErrorSignatures.length && !repeatedErrorSignatures.length) {
    return { madeProgress: true, reason: "错误变了 —— 还没成，但在推进", signals }
  }

  // 无进展的具体理由（直接进受阻报告）
  let reason
  if (repeatedErrorSignatures.length) {
    reason = filesChanged.length
      ? `改了 ${filesChanged.length} 个文件，但 ${repeatedErrorSignatures.length} 个错误一字不差地重复`
      : `同样的 ${repeatedErrorSignatures.length} 个错误原样重复，没有任何文件变更`
  } else if (!filesChanged.length) {
    reason = "没有文件变更、没有判据或门禁跃迁"
  } else {
    reason = "有文件变更但没有任何可验证的状态跃迁"
  }
  if (!planChanged && prev.planSig && next.planSig) {
    reason += "；计划结构与上一轮相同"
  }
  return { madeProgress: false, reason, signals }
}
