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

async function runScenario(sessionId, { prompt, config }) {  // config 由 ultraConfig(gates, {ultra}) 构造
  const capture = captureEvents()
  const result = await runHybridLongAgent({
    prompt, model: "mock-model", providerType: "mock_ultra", sessionId, configState: config
  })
  capture.stop()
  return {
    result,
    // heartbeat 是节流的保活信号，不属于编排语义，快照不锁它
    ultraEvents: capture.types().filter((type) => type.startsWith("longagent.") && type !== "longagent.heartbeat"),
    state: await LongAgentManager.get(sessionId)
  }
}

test("不可执行的目标在 H0 之前返回，不产生任何编排事件", async () => {
  const { result, ultraEvents, state } = await runScenario("parity_blocked", {
    prompt: "你好",
    config: ultraConfig()
  })

  assert.deepEqual(ultraEvents, [], "早退路径不该发出任何编排事件")
  // 0.5.0 起改名 needs_objective —— 原来的 "blocked" 与受阻语义撞词
  assert.equal(result.status, "needs_objective")
  assert.equal(result.phase, "H0")
  assert.equal(result.stageCount, 0)
  assert.deepEqual(result.taskProgress, {})
  assert.equal(state.status, "needs_objective")
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

test("门禁失败（单轮）：编排路径不变，状态诚实地报 partial", async () => {
  const { result, ultraEvents, state } = await runScenario("parity_gatefail", {
    prompt: "build two independent modules and wire them together",
    // max_rounds: 1 钉住单轮语义；非 TTY 收口为 deliver_partial
    config: ultraConfig({ gates: { build: { enabled: true } } }, { ultra: { max_rounds: 1 } })
  })

  // 与成功路径逐字相同：差别只在门禁结论，不在编排
  assert.deepEqual(ultraEvents.filter((t) => t !== "longagent.alert"), FULL_RUN_EVENTS)

  // 0.4.x 报 "failed"。判据其实全过、产物都在，只是门禁没绿 ——
  // 诚实的说法是 partial（部分交付），且会话保持 active 可续跑。
  assert.equal(result.status, "partial")
  assert.equal(result.stageIndex, 2, "门禁失败不该回滚已完成的 stage")
  assert.deepEqual(result.fileChanges.map((f) => f.path), ["src/core.mjs", "src/wire.mjs"])
  assert.equal(result.gateStatus.usabilityGates.status, "fail")
  assert.match(result.gateStatus.usabilityGates.failures, /build:/)
  assert.equal(result.goalVerification.status, "met", "判据本身是过的 —— 卡的是门禁")

  // failed 只留给 fatal；活没干完 ≠ 会话坏了
  assert.equal(state.status, "partial")
})

test("门禁失败（多轮）：停滞检测在两轮无进展后受阻收口", async () => {
  const { result } = await runScenario("parity_gatefail_rounds", {
    prompt: "build two independent modules and wire them together",
    config: ultraConfig({ gates: { build: { enabled: true } } })   // max_rounds 默认 0 = 不限
  })

  // 轮次循环：第 1 轮有产出 → 第 2、3 轮无进展 → 停滞 → 非 TTY 收口 deliver_partial
  assert.equal(result.status, "partial")
  const { loadLedger } = await import("../src/session/ultra-ledger.mjs")
  const ledger = await loadLedger("parity_gatefail_rounds", tmpProject)
  assert.ok(ledger, "台账必须落盘")
  assert.equal(ledger.data.rounds.length, 3, "1 轮产出 + 2 轮无进展 = 停滞阈值")
  assert.equal(ledger.data.rounds[2].progress.madeProgress, false)
  assert.match(ledger.data.rounds[2].progress.reason, /没有.*跃迁|计划结构/)
  const interaction = ledger.data.userInteractions.find((i) => i.action === "deliver_partial")
  assert.ok(interaction, "非 TTY 收口的决定必须记进台账")
  assert.equal(interaction.source, "non_tty_default")
})

test("未达成路径带上可交付给用户的报告与诊断", async () => {
  const { result } = await runScenario("parity_recovery", {
    prompt: "build two independent modules and wire them together",
    config: ultraConfig({ gates: { build: { enabled: true } } }, { ultra: { max_rounds: 1 } })
  })

  assert.equal(result.status, "partial")
  assert.ok(result.recoverySuggestions, "非 completed 的结果必须带诊断")
  assert.ok(result.recoverySuggestions.summary)
  assert.ok(result.blockedReport, "受阻报告必须随结果返回")
  assert.equal(result.blockedReport.status, "partial")
  assert.ok(result.reportPath, "report.md 必须落盘")
  assert.ok(result.ledgerPath)
})
