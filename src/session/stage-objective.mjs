import { stat } from "node:fs/promises"
import path from "node:path"

/**
 * Stage 目标达成核验。
 *
 * 0.4.1 之前，一个 stage 是否算完成完全取决于 worker 有没有在回复里吐出
 * `[TASK_COMPLETE]` 标记。标记没吐出来，stage 就 !allSuccess，H4 循环
 * `continue` 重跑同一个 stage —— 哪怕文件早就写好、测试早就通过了。
 * 加上降级链会把 recoveryCount 重置为 0，重跑可以持续到阶段超时为止。
 *
 * 这里补上客观判据：不问 worker 说了什么，只看目标有没有真的达成。
 * 声明的 plannedFiles 全部落地，且 build / test 门禁通过，就认定完成。
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

  const build = gates.results?.build || gates.build || {}
  const test = gates.results?.test || gates.test || {}
  const decisive = [build, test].filter((g) => g && g.enabled !== false && g.status !== "disabled")
  if (!decisive.length) {
    return { status: OBJECTIVE_UNKNOWN, reason: "build and test gates are disabled", missing: [], gates }
  }
  const failed = decisive.filter((g) => g.status !== "pass" && g.status !== "not_applicable")
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
