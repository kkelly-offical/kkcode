import test from "node:test"
import assert from "node:assert/strict"
import {
  TURN_PHASES,
  markTurnSubmitted,
  reduceTurnRuntime,
  resetTurnRuntime,
  turnPhaseOf
} from "../src/ui/turn-runtime.mjs"
import { createReplUiState } from "../src/repl/ui-state.mjs"
import { EVENT_TYPES } from "../src/kernel/core/constants.mjs"

/**
 * 渲染层回合状态机的契约：相位是显式的，结束路径全部确定性回到 idle。
 * 用户报告的 bug 是「一轮对话结束之后，它突然又会开始进入思考中」——
 * 这些用例把「结束之后不能再像思考中」钉死。
 */

function activeUi() {
  const ui = createReplUiState()
  markTurnSubmitted(ui)
  reduceTurnRuntime(ui, { type: EVENT_TYPES.TURN_START, turnId: "turn_1", payload: {} })
  return ui
}

test("a fresh UI is idle, and a missing phase reads as idle", () => {
  assert.equal(turnPhaseOf(createReplUiState()), "idle")
  assert.equal(turnPhaseOf({}), "idle", "手搓的旧式 ui 没有 turnPhase 字段")
  assert.equal(turnPhaseOf(null), "idle")
  assert.ok(TURN_PHASES.includes("finishing"))
})

test("submitting a turn enters the starting phase before any engine event", () => {
  const ui = createReplUiState()
  ui.currentActivity = { type: "tool", tool: "read" }
  ui.currentStep = 7
  markTurnSubmitted(ui)
  assert.equal(ui.busy, true)
  assert.equal(ui.turnPhase, "starting")
  assert.equal(ui.currentActivity, null, "上一回合的活动态不能带进下一回合")
  assert.equal(ui.currentStep, 0)
})

test("the active phase tracks steps, tools, writing and retries", () => {
  const ui = activeUi()
  assert.equal(ui.turnPhase, "active")
  assert.equal(ui.activeTurnId, "turn_1")

  reduceTurnRuntime(ui, { type: EVENT_TYPES.TURN_STEP_START, payload: { step: 2 } }, { maxSteps: 25 })
  assert.deepEqual(ui.currentActivity, { type: "thinking" })
  assert.equal(ui.currentStep, 2)
  assert.equal(ui.maxSteps, 25)

  reduceTurnRuntime(ui, { type: EVENT_TYPES.TOOL_START, payload: { tool: "bash", args: { command: "ls" } } })
  assert.equal(ui.currentActivity.type, "tool")

  for (const type of [EVENT_TYPES.TOOL_FINISH, EVENT_TYPES.TOOL_ERROR]) {
    reduceTurnRuntime(ui, { type, payload: { tool: "bash" } })
    assert.deepEqual(ui.currentActivity, { type: "thinking" }, `${type} 之后回到思考态`)
  }

  reduceTurnRuntime(ui, { type: EVENT_TYPES.STREAM_TEXT_START, payload: {} })
  assert.deepEqual(ui.currentActivity, { type: "writing" })

  reduceTurnRuntime(ui, {
    type: EVENT_TYPES.PROVIDER_RETRY,
    payload: { retryAttempt: 2, maxRetries: 5, classification: "timeout" }
  })
  assert.deepEqual(ui.currentActivity, { type: "retry", attempt: 2, max: 5, classification: "timeout" })
})

test("turn.finish lands in finishing — never back in a thinking-like state", () => {
  const ui = activeUi()
  reduceTurnRuntime(ui, { type: EVENT_TYPES.TOOL_START, payload: { tool: "read" } })
  reduceTurnRuntime(ui, { type: EVENT_TYPES.TURN_FINISH, payload: {} })
  assert.equal(ui.turnPhase, "finishing")
  assert.equal(ui.currentActivity, null, "结束后没有活动态")
  assert.equal(ui.activeTurnId, null)
  assert.equal(ui.currentStep, 0)
  assert.equal(ui.busy, true, "呈现结果期间仍是 busy —— 但相位是 finishing")
})

test("turn.error follows the same deterministic settle", () => {
  const ui = activeUi()
  reduceTurnRuntime(ui, { type: EVENT_TYPES.PROVIDER_RETRY, payload: { retryAttempt: 1, maxRetries: 3 } })
  reduceTurnRuntime(ui, { type: EVENT_TYPES.TURN_ERROR, payload: { error: "boom" } })
  assert.equal(ui.turnPhase, "finishing")
  assert.equal(ui.currentActivity, null, "重试活动态必须清掉，不能残留成「还在重试」")
})

test("an approval-denied tool settles the turn without residue", () => {
  // 审批拒绝 → 工具 blocked/errored → 回合收尾。呈现层不能留下任何活动痕迹。
  const ui = activeUi()
  reduceTurnRuntime(ui, { type: EVENT_TYPES.TOOL_START, payload: { tool: "write" } })
  reduceTurnRuntime(ui, { type: EVENT_TYPES.TOOL_ERROR, payload: { tool: "write", status: "blocked" } })
  reduceTurnRuntime(ui, { type: EVENT_TYPES.TURN_FINISH, payload: {} })
  resetTurnRuntime(ui)
  assert.equal(ui.turnPhase, "idle")
  assert.equal(ui.busy, false)
  assert.equal(ui.currentActivity, null)
  assert.equal(ui.activeTurnId, null)
  assert.equal(ui.turnAbortController, null)
})

test("a remote turn settles straight to idle on finish", () => {
  const ui = activeUi()
  ui.remoteTurn = true
  reduceTurnRuntime(ui, { type: EVENT_TYPES.TURN_FINISH, payload: {} })
  assert.equal(ui.turnPhase, "idle", "远程回合没有本地的呈现收尾路径")
})

test("a late compaction result cannot resurrect thinking after the turn ended", () => {
  const ui = activeUi()
  reduceTurnRuntime(ui, { type: EVENT_TYPES.SESSION_COMPACTING, payload: {} })
  assert.deepEqual(ui.currentActivity, { type: "compacting" })
  reduceTurnRuntime(ui, { type: EVENT_TYPES.TURN_FINISH, payload: {} })
  reduceTurnRuntime(ui, { type: EVENT_TYPES.SESSION_COMPACTED, payload: {} })
  assert.equal(ui.currentActivity, null, "回合结束后迟到的 compacted 不得复活活动态")
  assert.equal(ui.turnPhase, "finishing")
})

test("mid-turn compaction settles back to thinking only while active", () => {
  const ui = activeUi()
  reduceTurnRuntime(ui, { type: EVENT_TYPES.SESSION_COMPACTING, payload: {} })
  reduceTurnRuntime(ui, { type: EVENT_TYPES.SESSION_COMPACTED, payload: {} })
  assert.deepEqual(ui.currentActivity, { type: "thinking" }, "回合内压缩结束回到思考态")
})

test("resetTurnRuntime is the single settle point for every exit path", () => {
  const ui = activeUi()
  ui.turnAbortController = { abort() {} }
  reduceTurnRuntime(ui, { type: EVENT_TYPES.TOOL_START, payload: { tool: "edit" } })
  resetTurnRuntime(ui)
  assert.equal(ui.busy, false)
  assert.equal(ui.turnPhase, "idle")
  assert.equal(ui.currentActivity, null)
  assert.equal(ui.currentStep, 0)
  assert.equal(ui.activeTurnId, null)
  assert.equal(ui.turnAbortController, null)
})

test("unrelated events do not touch the turn runtime", () => {
  const ui = activeUi()
  const before = { phase: ui.turnPhase, activity: ui.currentActivity }
  assert.equal(reduceTurnRuntime(ui, { type: "some.future.event", payload: {} }), false)
  assert.equal(ui.turnPhase, before.phase)
  assert.equal(ui.currentActivity, before.activity)
})
