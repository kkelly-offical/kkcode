import test from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"
import { renderFileChangesPanel, renderInspectorOverlay, renderLongAgentPanel } from "../src/ui/tui-helpers.mjs"

function stripAnsi(text) {
  return String(text || "").replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07)/g, "")
}

test("renderLongAgentPanel shows stage history and recovery hints", () => {
  const output = renderLongAgentPanel({
    sessionId: "ses_longagent_panel",
    status: "running",
    phase: "H4",
    currentGate: "stage:ui",
    currentStageId: "ui-panel",
    remainingFilesCount: 2,
    remainingFiles: ["src/ui/repl-dashboard.mjs", "src/ui/tui-helpers.mjs"],
    backgroundTaskId: "bg_demo",
    backgroundTaskStatus: "running",
    backgroundTaskAttempt: 2,
    checkpoints: [
      { id: "cp_stage_1", phase: "H2", kind: "stage", summary: "started stage provider-runtime" },
      { id: "cp_stage_2", phase: "H4", kind: "stage", summary: "completed stage ui-panel" }
    ],
    progress: { percentage: 67 },
    iterations: 8,
    maxIterations: 20,
    recoveryCount: 1,
    stageProgress: { done: 4, total: 6 },
    lastMessage: "updating terminal panel",
    lastStageReport: {
      stageId: "provider-runtime",
      status: "pass",
      successCount: 3,
      failCount: 0,
      retryCount: 1,
      fileChangesCount: 4,
      remainingFilesCount: 0,
      totalCost: 0.0421
    },
    stageReports: [
      { stageId: "catalog", status: "pass", successCount: 2, failCount: 0 },
      { stageId: "runtime", status: "pass", successCount: 3, failCount: 0 },
      { stageId: "ui-panel", status: "fail", successCount: 2, failCount: 1 }
    ],
    recoverySuggestions: ["Re-run the UI snapshot checks after adjusting widths."]
  }, {
    width: 100,
    theme: DEFAULT_THEME
  }).map(stripAnsi).join("\n")

  assert.match(output, /Last Stage/)
  assert.match(output, /Recent Stages/)
  assert.match(output, /Recovery Hints/)
  assert.match(output, /Recommended Action/)
  assert.match(output, /recover-checkpoint cp_stage_2/)
  assert.match(output, /recovery_count=1/)
  assert.match(output, /Timeline/)
  assert.match(output, /stage ui-panel FAIL 2 ok\/1 fail/)
  assert.match(output, /background running bg_demo attempt=2/)
  assert.match(output, /Recent Checkpoints/)
  assert.match(output, /\[recommended\]/)
  assert.match(output, /completed stage ui-panel/)
  assert.match(output, /bg=running/)
  assert.match(output, /provider-runtime PASS 3 ok \/ 0 fail/)
  assert.match(output, /ui-panel FAIL 2\/3 ok/)
})

test("renderFileChangesPanel shows compact file stats", () => {
  const output = renderFileChangesPanel([
    { path: "src/ui/repl.mjs", addedLines: 42, removedLines: 7, stageId: "ui", taskId: "panel" },
    { path: "src/provider/router.mjs", addedLines: 8, removedLines: 2 }
  ], {
    width: 100,
    theme: DEFAULT_THEME
  }).map(stripAnsi).join("\n")

  assert.match(output, /Recent File Changes/)
  assert.match(output, /src\/ui\/repl\.mjs \+42 -7 ui\/panel/)
  assert.match(output, /src\/provider\/router\.mjs \+8 -2/)
})

test("renderInspectorOverlay summarizes runtime and file changes", () => {
  const output = renderInspectorOverlay({
    mode: "longagent",
    providerType: "openai",
    model: "gpt-5",
    providerSwitches: [
      "startup: openai / gpt-5",
      "provider: anthropic / claude-opus-4-6"
    ],
    recoverableSessions: [
      { id: "ses_recover_1", status: "error", retryable: true },
      { id: "ses_recover_2", status: "running", retryable: false }
    ],
    longagentState: {
      status: "running",
      phase: "H4",
      currentGate: "stage:ui",
      currentStageId: "ui-overlay",
      remainingFilesCount: 1,
      recoveryCount: 2,
      sessionId: "ses_overlay",
      backgroundTaskId: "bg_overlay",
      backgroundTaskStatus: "interrupted",
      backgroundTaskAttempt: 3,
      checkpoints: [
        { phase: "H4", kind: "stage", summary: "failed stage ui-overlay" }
      ],
      lastStageReport: {
        stageId: "provider-runtime",
        status: "pass",
        successCount: 4,
        failCount: 0
      },
      recoverySuggestions: ["Re-check overlay widths on narrow terminals."]
    },
    fileChanges: [
      { path: "src/repl.mjs", addedLines: 20, removedLines: 3, stageId: "ui", taskId: "overlay" }
    ],
    backgroundSummary: {
      total: 4,
      running: 1,
      pending: 1,
      interrupted: 1,
      error: 1,
      completed: 1,
      longagent: 2,
      recovery: 1
    },
    backgroundTasks: [
      { id: "bg_overlay", label: "longagent", status: "interrupted", sessionId: "ses_overlay" },
      { id: "bg_retry", label: "recovery", status: "pending", sessionId: "ses_retry" }
    ],
    width: 100,
    theme: DEFAULT_THEME
  }).map(stripAnsi).join("\n")

  assert.match(output, /Inspector/)
  assert.match(output, /mode=longagent provider=openai model=gpt-5/)
  assert.match(output, /Provider Timeline/)
  assert.match(output, /provider: anthropic \/ claude-opus-4-6/)
  assert.match(output, /Recovery Center/)
  assert.match(output, /ses_recover_1 error retry/)
  assert.match(output, /background=interrupted task=bg_overlay attempt=3/)
  assert.match(output, /Recent Checkpoints/)
  assert.match(output, /failed stage ui-overlay/)
  assert.match(output, /Timeline/)
  assert.match(output, /background interrupted bg_overlay attempt=3/)
  assert.match(output, /Recovery Actions/)
  assert.match(output, /kkcode longagent recover --session ses_overlay/)
  assert.match(output, /Background Tasks/)
  assert.match(output, /total=4 running=1 pending=1 interrupted=1 error=1/)
  assert.match(output, /bg_retry recovery pending session=ses_retry/)
  assert.match(output, /provider-runtime PASS 4 ok \/ 0 fail/)
  assert.match(output, /src\/repl\.mjs \+20 -3 ui\/overlay/)
  assert.match(output, /Esc close Ctrl\+I toggle/)
})
