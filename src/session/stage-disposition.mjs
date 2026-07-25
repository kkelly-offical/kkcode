import { ERROR_CATEGORIES } from "./longagent-utils.mjs"

/**
 * Stage 失败的分档处置 —— 纯函数决策表，逐行可测。
 *
 * 0.4.x 只有两种结局：重试，或 `break` 掉**整个 stage 循环**（放弃当前 stage
 * 以及所有后续 stage）。更糟的是 PERMANENT 错误的 task 被留在 error 态，
 * allSuccess 永不为真，一个注定失败的 stage 要烧满 12 次尝试加 28 秒退避
 * 才轮到那个 break。
 *
 * 现在的语义：
 *   RETRY   — 瞬时错误，按原有退避重试
 *   DEGRADE — 重试额度用完但降级链还有档位
 *   DEFER   — 挪到本轮末尾再试一次（后续 stage 不依赖它时）
 *   SKIP    — 记失败、推进 stageIndex，**不连累无关的后续 stage**
 *   REPLAN  — 结束本轮，把失败证据喂回 blueprint 修订剩余计划
 *   ABORT   — 结束本轮且不再跑后续 stage（用户停止 / 无路可走）
 */

export const DISPOSITION = Object.freeze({
  RETRY: "retry",
  DEGRADE: "degrade",
  DEFER: "defer",
  SKIP: "skip",
  REPLAN: "replan",
  ABORT: "abort"
})

/**
 * 后续 stage 是否依赖第 index 个 stage 的产物。
 * 判据：后续 task 的 plannedFiles 或 prompt 引用了本 stage 的 plannedFiles，
 * 或显式 dependsOn 指向本 stage 的 task。
 */
export function hasDependents(stagePlan, index) {
  const stages = stagePlan?.stages || []
  const current = stages[index]
  if (!current) return false
  const files = new Set((current.tasks || []).flatMap((t) => t.plannedFiles || []))
  const taskIds = new Set((current.tasks || []).map((t) => t.taskId))
  for (const later of stages.slice(index + 1)) {
    for (const task of later.tasks || []) {
      if ((task.dependsOn || []).some((dep) => taskIds.has(dep))) return true
      if ((task.plannedFiles || []).some((file) => files.has(file))) return true
      if (files.size && [...files].some((file) => String(task.prompt || "").includes(file))) return true
    }
  }
  return false
}

/**
 * @param {object} p
 * @param {string[]} p.errorCategories 失败 task 的错误分类（classifyError 的产物）
 * @returns {{disposition: string, reason: string}}
 */
export function decideStageDisposition({
  stopped = false,
  planDefect = false,
  recoveries = 0,
  maxRecoveries = 3,
  attempts = 0,
  maxAttempts = 12,
  errorCategories = [],
  stageHasDependents = false,
  alreadyDeferred = false,
  alreadyReplanned = false,
  canDegrade = false,
  roundsLeft = true,
  allowSkip = true,
  allowDefer = true
} = {}) {
  if (stopped) return { disposition: DISPOSITION.ABORT, reason: "收到停止请求" }

  if (planDefect) {
    return roundsLeft && !alreadyReplanned
      ? { disposition: DISPOSITION.REPLAN, reason: "计划结构缺陷（依赖环/文件所有权冲突），重试同一计划不会有改善" }
      : { disposition: DISPOSITION.ABORT, reason: "计划结构缺陷且无法重规划" }
  }

  const categories = errorCategories.filter(Boolean)
  const allHopeless = categories.length > 0 && categories.every(
    (c) => c === ERROR_CATEGORIES.PERMANENT || c === ERROR_CATEGORIES.UNKNOWN
  )

  // 全部剩余失败都是永久性错误 —— 0.4.x 会退避重试 12 轮，明知不可能改善。
  if (allHopeless) {
    if (roundsLeft && !alreadyReplanned && stageHasDependents) {
      return { disposition: DISPOSITION.REPLAN, reason: "失败全为永久性错误且后续 stage 依赖本产物，重试无意义，需要换路线" }
    }
    if (allowSkip && !stageHasDependents) {
      return { disposition: DISPOSITION.SKIP, reason: "失败全为永久性错误、无下游依赖 —— 跳过，不连累后续 stage" }
    }
    return roundsLeft && !alreadyReplanned
      ? { disposition: DISPOSITION.REPLAN, reason: "失败全为永久性错误，需要换路线" }
      : { disposition: DISPOSITION.SKIP, reason: "失败全为永久性错误且无路可退，记失败并继续" }
  }

  if (recoveries < maxRecoveries) {
    return { disposition: DISPOSITION.RETRY, reason: `瞬时错误，重试（${recoveries + 1}/${maxRecoveries}）` }
  }

  if (canDegrade) {
    return { disposition: DISPOSITION.DEGRADE, reason: "重试额度用尽，先降级再试" }
  }

  if (attempts >= maxAttempts) {
    if (allowDefer && !alreadyDeferred && !stageHasDependents) {
      return { disposition: DISPOSITION.DEFER, reason: `累计 ${attempts} 次尝试用尽，延后到本轮末尾再试一次` }
    }
    if (roundsLeft && !alreadyReplanned) {
      return { disposition: DISPOSITION.REPLAN, reason: `累计 ${attempts} 次尝试用尽，交给重规划换路线` }
    }
    // 0.4.x 在这里 break 掉一切。SKIP 才是对的：一个 stage 卡死不该没收
    // 其余无关工作。
    return { disposition: DISPOSITION.SKIP, reason: `累计 ${attempts} 次尝试用尽且无法重规划，记失败并继续后续 stage` }
  }

  return { disposition: DISPOSITION.RETRY, reason: "还有尝试额度，继续重试" }
}
