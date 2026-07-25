import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * Ultra 行为快照。
 *
 * 这是 0.5.0 阶段 1 把 runHybridLongAgent 拆成阶段函数时的安全网 ——
 * 抽取是纯搬家，事件序列、结果字段、会话最终状态都必须逐字不变。
 * **必须在动代码之前落地**，否则「重构没改变行为」就只是一句自我安慰。
 *
 * 快照写成字面量而不是 golden 文件：行为一旦改变，diff 里能直接看见改了什么。
 * 阶段 4 起会有意改变这些序列（轮次循环、分档处置），届时这里同步更新即可 ——
 * 那时的改动是有意的，能在 review 里被看见，这正是快照的意义。
 */

const tmpHome = await mkdtemp(path.join(os.tmpdir(), "kkcode-parity-home-"))
const tmpProject = await mkdtemp(path.join(os.tmpdir(), "kkcode-parity-proj-"))
process.env.KKCODE_HOME = tmpHome
const originalCwd = process.cwd()
process.chdir(tmpProject)

const { registerProvider } = await import("../src/provider/router.mjs")
const { runHybridLongAgent } = await import("../src/session/longagent-hybrid.mjs")
const { LongAgentManager } = await import("../src/orchestration/longagent-manager.mjs")
const { createScriptedProvider, stagePlanFence, captureEvents, ultraConfig } =
  await import("./helpers/ultra-harness.mjs")
const { installBackgroundMock, restoreBackgroundMock } = await import("./helpers/background-mock.mjs")

const PLAN = {
  planId: "plan_parity",
  objective: "build two modules",
  stages: [
    {
      stageId: "stage_1",
      name: "Core",
      tasks: [{ taskId: "t_core", prompt: "write src/core.mjs", plannedFiles: ["src/core.mjs"], acceptance: ["node --check src/core.mjs"] }]
    },
    {
      stageId: "stage_2",
      name: "Wire",
      tasks: [{ taskId: "t_wire", prompt: "write src/wire.mjs", plannedFiles: ["src/wire.mjs"], acceptance: ["node --check src/wire.mjs"] }]
    }
  ]
}

registerProvider("mock_ultra", createScriptedProvider([
  { stage: 1, reply: "Findings: plain ESM project, no build tooling." },
  { stage: 2, reply: stagePlanFence(PLAN) },
  { stage: 4, reply: "All checks pass.\n[STAGE 4/4: DEBUGGING - COMPLETE]\n[TASK_COMPLETE]" }
], { fallback: "acknowledged" }))

installBackgroundMock({ reply: "[TASK_COMPLETE] wrote the file" })

// build 脚本必然失败，用于门禁失败场景；test gate 没有 test 脚本与 test/ 目录，
// 会判 not_applicable，所以只有 build 会红。
await writeFile(
  path.join(tmpProject, "package.json"),
  JSON.stringify({ name: "parity", version: "1.0.0", scripts: { build: "node -e \"process.exit(1)\"" } })
)

test.after(async () => {
  restoreBackgroundMock()
  process.chdir(originalCwd)
  await rm(tmpHome, { recursive: true, force: true }).catch(() => {})
  await rm(tmpProject, { recursive: true, force: true }).catch(() => {})
})

/** H1 → H2 → H4(两个 stage) → H5 → H6 的完整事件序列。 */
const FULL_RUN_EVENTS = [
  "longagent.phase.changed",              // → H1
  "longagent.hybrid.preview.start",
  "longagent.hybrid.preview.complete",
  "longagent.phase.changed",              // → H2
  "longagent.hybrid.blueprint.start",
  "longagent.hybrid.blueprint.complete",
  "longagent.plan.frozen",
  "longagent.hybrid.blueprint.validated",
  "longagent.phase.changed",              // → H4
  "longagent.stage.started",
  "longagent.stage.task.dispatched",
  "longagent.stage.task.finished",
  "longagent.stage.finished",
  "longagent.stage.started",
  "longagent.stage.task.dispatched",
  "longagent.stage.task.finished",
  "longagent.stage.finished",
  "longagent.phase.changed",              // → H5
  "longagent.hybrid.debugging.start",
  "longagent.hybrid.debugging.complete",
  "longagent.phase.changed",              // → H6
  "longagent.gate.checked",
  "longagent.gate.checked",
  "longagent.gate.checked",
  "longagent.gate.checked",
  "longagent.gate.checked"
]

async function runScenario(sessionId, { prompt, config }) {
  const capture = captureEvents()
  const result = await runHybridLongAgent({
    prompt, model: "mock-model", providerType: "mock_ultra", sessionId, configState: config
  })
  capture.stop()
  return {
    result,
    ultraEvents: capture.types().filter((type) => type.startsWith("longagent.")),
    state: await LongAgentManager.get(sessionId)
  }
}

test("不可执行的目标在 H0 之前返回，不产生任何编排事件", async () => {
  const { result, ultraEvents, state } = await runScenario("parity_blocked", {
    prompt: "你好",
    config: ultraConfig()
  })

  assert.deepEqual(ultraEvents, [], "早退路径不该发出任何编排事件")
  assert.equal(result.status, "blocked")
  assert.equal(result.phase, "H0")
  assert.equal(result.stageCount, 0)
  assert.deepEqual(result.taskProgress, {})
  assert.equal(state.status, "blocked")
})

test("完整一轮：H1 到 H6 的事件序列与产物", async () => {
  const { result, ultraEvents, state } = await runScenario("parity_happy", {
    prompt: "build two independent modules and wire them together",
    config: ultraConfig()
  })

  assert.deepEqual(ultraEvents, FULL_RUN_EVENTS)

  assert.equal(result.status, "completed")
  assert.equal(result.phase, "H6")
  assert.equal(result.stageCount, 2)
  assert.equal(result.stageIndex, 2, "两个 stage 都应推进完")
  assert.equal(result.currentStageId, "stage_2")
  assert.deepEqual(Object.keys(result.taskProgress).sort(), ["t_core", "t_wire"])
  assert.deepEqual(result.fileChanges.map((f) => f.path), ["src/core.mjs", "src/wire.mjs"])

  // blueprint 一次解析成功。上面的事件序列里没有 longagent.alert，已经蕴含了
  // 「没有触发 blueprint_parse_retry」—— 一旦重解析，说明计划没被用上、流程
  // 退回了默认的单 stage 计划，那时这个快照锁住的就是一个坏基线。
  assert.equal(result.gateStatus.blueprint.stageCount, 2, "用的必须是脚本给的两阶段计划")
  // H5 一轮拿到完成标记；空转满 20 轮同样是「看起来跑完了」的假象
  assert.deepEqual(result.gateStatus.debugging, { status: "pass", iterations: 1 })
  assert.deepEqual(result.gateStatus.usabilityGates, { status: "pass", attempt: 1 })
  assert.deepEqual(result.stageProgress, { done: 2, total: 2 })

  assert.equal(state.status, "completed")
  assert.equal(state.stageCount, 2)
})

test("门禁失败只改变结果，不改变编排路径", async () => {
  const { result, ultraEvents, state } = await runScenario("parity_gatefail", {
    prompt: "build two independent modules and wire them together",
    config: ultraConfig({ gates: { build: { enabled: true } } })
  })

  // 与成功路径逐字相同：差别只在门禁结论，不在编排
  assert.deepEqual(ultraEvents, FULL_RUN_EVENTS)

  assert.equal(result.status, "failed")
  assert.equal(result.stageIndex, 2, "门禁失败不该回滚已完成的 stage")
  assert.deepEqual(result.fileChanges.map((f) => f.path), ["src/core.mjs", "src/wire.mjs"])
  assert.equal(result.gateStatus.usabilityGates.status, "fail")
  assert.match(result.gateStatus.usabilityGates.failures, /build:/)
  assert.match(result.reply, /failed usability gates/)

  // 只有 fatal 才配得上 failed 会话状态；门禁没过说明活没干完，不是会话坏了
  assert.equal(state.status, "failed")
})

test("失败路径带上可交付给用户的诊断", async () => {
  const { result } = await runScenario("parity_recovery", {
    prompt: "build two independent modules and wire them together",
    config: ultraConfig({ gates: { build: { enabled: true } } })
  })

  assert.equal(result.status, "failed")
  assert.ok(result.recoverySuggestions, "非 completed 的结果必须带诊断")
  assert.ok(result.recoverySuggestions.summary)
  assert.ok(Array.isArray(result.recoverySuggestions.manualSteps))
})
