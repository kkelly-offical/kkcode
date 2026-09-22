import test from "node:test"
import assert from "node:assert/strict"
import { buildBusyLine, BUSY_SPINNER_FRAMES, formatBusyToolDetail } from "../src/ui/busy-line.mjs"
import { createReplUiState } from "../src/repl/ui-state.mjs"
import { createThinkingState } from "../src/ui/thinking-state.mjs"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"

/**
 * 忙碌行的文案分派契约。最关键的一条：回合结束后的呈现窗口（finishing）
 * 绝不能回落成 Starting/Thinking —— 那是用户报告的「结束后又开始思考」。
 */

const NOW = 1_700_000_000_000

function busyUi(patch = {}) {
  const ui = createReplUiState()
  ui.busy = true
  ui.spinnerIndex = 0
  return Object.assign(ui, patch)
}

function render(ui) {
  return buildBusyLine({ ui, theme: DEFAULT_THEME, now: NOW })
    // 颜色码与本契约无关，只看文案
    .replace(/\x1b\[[0-9;]*m/g, "")
}

test("idle renders nothing", () => {
  assert.equal(render(createReplUiState()), "")
})

test("the finishing phase winds down quietly instead of looking like thinking", () => {
  const ui = busyUi({ turnPhase: "finishing" })
  const line = render(ui)
  assert.match(line, /Finishing/)
  assert.doesNotMatch(line, /Starting|Thinking|Waiting|Working/,
    "收尾帧不得显示任何「又开始思考」的文案")
})

test("the starting phase still announces itself before the first step event", () => {
  const ui = busyUi({ turnPhase: "starting" })
  assert.match(render(ui), /Starting\.+/)
})

test("a longagent gap reads Working, not Starting", () => {
  const ui = busyUi({ turnPhase: "starting" })
  ui.metrics.longagent = { phase: "build" }
  assert.match(render(ui), /Working\.+/)
})

test("tool activity shows the tool name and step progress", () => {
  const ui = busyUi({
    turnPhase: "active",
    currentStep: 3,
    maxSteps: 10,
    currentActivity: { type: "tool", tool: "bash", args: { command: "npm test" } }
  })
  const line = render(ui)
  assert.match(line, /bash/)
  assert.match(line, /npm test/)
  assert.match(line, /\[3\/10\]/)
})

test("streaming thinking carries the elapsed timer", () => {
  const ui = busyUi({
    turnPhase: "active",
    currentActivity: { type: "thinking" },
    thinking: { ...createThinkingState(), phase: "streaming", startedAt: NOW - 10_000 }
  })
  assert.match(render(ui), /Thinking\.+\s+· 10s/)
})

test("a waiting gap without a clock anchor shows no frozen 0.0s", () => {
  const ui = busyUi({
    turnPhase: "active",
    currentActivity: { type: "thinking" },
    thinking: createThinkingState()
  })
  const line = render(ui)
  assert.match(line, /Waiting\.+/)
  assert.doesNotMatch(line, /0\.0s/)
})

test("retry and compacting activities keep their own wording", () => {
  const retry = busyUi({
    turnPhase: "active",
    currentActivity: { type: "retry", attempt: 2, max: 5, classification: "timeout" }
  })
  assert.match(render(retry), /Retrying 2\/5[.\s]+· timeout/)

  const compacting = busyUi({ turnPhase: "active", currentActivity: { type: "compacting" } })
  assert.match(render(compacting), /Compacting\.+/)
})

test("spinner frames and tool detail helpers are importable from the new home", () => {
  assert.ok(BUSY_SPINNER_FRAMES.length > 0)
  assert.match(formatBusyToolDetail("read", { path: "src/x.mjs" }).replace(/\x1b\[[0-9;]*m/g, ""), /src\/x\.mjs/)
  assert.equal(formatBusyToolDetail("unknown", {}), "")
})
