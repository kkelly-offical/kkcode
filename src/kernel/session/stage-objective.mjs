import { stat } from "node:fs/promises"
import path from "node:path"
import { readGate, isDecisiveGate, isPassingGateStatus } from "./gate-contract.mjs"

/**
 * Stage 目标达成核验。
 *
 * H4 判定一个 stage 成功与否看的是 allSuccess，而 allSuccess 的真实判据是
 * 「该 stage 每个 task 声明的 plannedFiles 都被 write 或 edit 工具动过」
 * （stage-scheduler.mjs 的 allSuccess 计算 + background-worker.mjs 的
 * remainingFiles 推导）—— 与 `[TASK_COMPLETE]` 标记无关，那个标记只影响
 * 最终 status 是 completed 还是 done。
 *
 * 问题在于这个判据看的是「工具调用有没有覆盖到声明的文件」，不是「东西有
 * 没有真的做出来」。worker 换了个文件名、或把内容并进了别的文件，
 * remainingFiles 就清不空，stage 判失败，H4 重跑同一个 stage —— 哪怕文件
 * 早就写好、测试早就通过。加上降级链会把 recoveryCount 重置为 0，重跑可以
 * 持续到阶段超时为止。
 *
 * 这里补上客观判据：不问工具调用覆盖了什么，只看目标有没有真的达成 ——
 * 声明的 plannedFiles 全部落地，且 build / test 门禁通过，就认定完成。
 *
 * ⚠ 0.4.2 引入这套判据时门禁结果的读取字段写错了（读 `gates.results.build`，
 * 而实际在 `gates.gates.build`），取到 undefined 后空对象既算「门禁生效」
 * 又算「判定失败」，于是文件齐备时必然返回 unmet，OBJECTIVE_MET 生产不可达，
 * 而单测因为 mock 了那个不存在的形状全绿。0.5.0 起门禁一律经
 * gate-contract.mjs 的 readGate() 读取 —— 形状不对会抛，不会静默取空。
 */

export const OBJECTIVE_MET = "met"
export const OBJECTIVE_UNMET = "unmet"
export const OBJECTIVE_UNKNOWN = "unknown"

/** 收集一个 stage 声明要产出的全部文件。 */
export function stagePlannedFiles(stage) {
  const files = []
  for (const task of stage?.tasks || []) {
    for (const file of task?.plannedFiles || []) {
      const value = String(file || "").trim()
      if (value && !files.includes(value)) files.push(value)
    }
  }
  return files
}

async function fileExists(cwd, relative, statFn) {
  try {
    const info = await statFn(path.resolve(cwd, relative))
    return info.isFile() ? info.size > 0 : false
  } catch {
    return false
  }
}

/**
 * @returns {{status, reason, missing: string[], gates: object|null}}
 *   met     — 目标已达成，调用方可以推进 stageIndex
 *   unmet   — 明确没达成，按原有重试逻辑走
 *   unknown — 无法判断（stage 没声明文件、门禁全禁用），不改变原有行为
 */
export async function verifyStageObjective({
  stage,
  cwd = process.cwd(),
  config = {},
  sessionId = "",
  iteration = 0,
  deps = {}
} = {}) {
  const statFn = deps.stat || stat
  const runGates = deps.runUsabilityGates

  const planned = stagePlannedFiles(stage)
  if (!planned.length) {
    // 没有可核对的产出，交回原逻辑判断
    return { status: OBJECTIVE_UNKNOWN, reason: "stage declares no planned files", missing: [], gates: null }
  }

  const missing = []
  for (const file of planned) {
    if (!(await fileExists(cwd, file, statFn))) missing.push(file)
  }
  if (missing.length) {
    return {
      status: OBJECTIVE_UNMET,
      reason: `${missing.length}/${planned.length} planned files missing or empty`,
      missing,
      gates: null
    }
  }

  // 文件都在，再让 build / test 说话。门禁不可用时不敢下「已完成」的结论。
  if (typeof runGates !== "function") {
    return { status: OBJECTIVE_UNKNOWN, reason: "no gate runner available", missing: [], gates: null }
  }

  const gates = await runGates({ sessionId, config, cwd, iteration }).catch(() => null)
  if (!gates) {
    return { status: OBJECTIVE_UNKNOWN, reason: "gate run failed", missing: [], gates: null }
  }

  let build, test
  try {
    build = readGate(gates, "build")
    test = readGate(gates, "test")
  } catch (err) {
    // 门禁返回形状漂移。宁可报 unknown 也不能猜 —— 猜错的代价是把没做完的
    // stage 判成完成，那比多跑一轮严重得多。
    return {
      status: OBJECTIVE_UNKNOWN,
      reason: `gate contract drift: ${err.message}`,
      missing: [],
      gates,
      contractError: err.message
    }
  }

  const decisive = [build, test].filter(isDecisiveGate)
  if (!decisive.length) {
    return { status: OBJECTIVE_UNKNOWN, reason: "build and test gates are disabled", missing: [], gates }
  }
  const failed = decisive.filter((g) => !isPassingGateStatus(g.status))
  if (failed.length) {
    return {
      status: OBJECTIVE_UNMET,
      reason: `gates failed: ${failed.map((g) => g.reason || g.status).join("; ").slice(0, 200)}`,
      missing: [],
      gates
    }
  }

  return {
    status: OBJECTIVE_MET,
    reason: `all ${planned.length} planned files exist and build/test pass`,
    missing: [],
    gates
  }
}
