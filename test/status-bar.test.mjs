import test from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"
import { renderStatusBar } from "../src/theme/status-bar.mjs"

function stripAnsi(text) {
  return String(text || "").replace(/\x1B\[[0-9;]*m/g, "")
}

test("status bar renders background and recovery summaries", () => {
  const output = stripAnsi(renderStatusBar({
    mode: "longagent",
    model: "gpt-5.3-codex",
    permission: "ask",
    tokenMeter: {
      estimated: false,
      turn: { input: 100, output: 50 },
      session: { input: 400, output: 200 },
      global: { input: 800, output: 400 }
    },
    aggregation: ["turn", "session", "global"],
    cost: 0.1234,
    savings: 0,
    showCost: true,
    showTokenMeter: true,
    theme: DEFAULT_THEME,
    layout: "compact",
    longagentState: {
      currentStageId: "provider-runtime",
      stageProgress: { done: 2, total: 5 },
      remainingFilesCount: 3,
      phase: "H4",
      recoveryCount: 1,
      progress: { percentage: 40 }
    },
    memoryLoaded: true,
    backgroundSummary: {
      total: 4,
      running: 2,
      pending: 1,
      interrupted: 1
    },
    recoverySummary: {
      total: 2,
      retryable: 1
    }
  }))

  assert.match(output, /BG R:2 P:1 I:1/)
  assert.match(output, /REC 2 retry:1/)
  assert.match(output, /LONG/)
})
