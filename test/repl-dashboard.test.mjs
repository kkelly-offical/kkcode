import test from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"
import { renderReplDashboard, renderReplLogo, renderStartupHint } from "../src/ui/repl-dashboard.mjs"

function stripAnsi(text) {
  return String(text || "").replace(/\x1B\[[0-9;]*m/g, "")
}

const baseInput = {
  theme: DEFAULT_THEME,
  state: {
    sessionId: "ses_demo_123456",
    mode: "agent",
    providerType: "openai",
    model: "gpt-4o-mini"
  },
  providers: ["openai", "anthropic", "ollama"],
  recentSessions: [],
  customCommandCount: 0,
  cwd: process.cwd()
}

test("dashboard renders without width overflow on narrow terminal", () => {
  const output = renderReplDashboard({
    ...baseInput,
    columns: 80
  })
  for (const line of output.split("\n")) {
    assert.ok(stripAnsi(line).length <= 80, `line overflow: ${stripAnsi(line).length}`)
  }
})

test("dashboard uses two-column frame on wide terminal", () => {
  const output = renderReplDashboard({
    ...baseInput,
    columns: 150
  })
  const lines = output.split("\n")
  const hasTwoColumn = lines.some((line) => {
    const raw = stripAnsi(line)
    const first = raw.indexOf("|")
    const second = raw.indexOf("|", first + 1)
    const third = raw.indexOf("|", second + 1)
    const fourth = raw.indexOf("|", third + 1)
    return first >= 0 && second > first && third > second && fourth > third
  })
  assert.equal(hasTwoColumn, true)
})

test("dashboard renders longagent runtime summary when present", () => {
  const output = stripAnsi(renderReplDashboard({
    ...baseInput,
    state: {
      ...baseInput.state,
      longagent: {
        status: "running",
        phase: "H4",
        currentGate: "stage:provider",
        currentStageId: "provider-runtime",
        stageIndex: 1,
        stageCount: 4,
        recoveryCount: 1,
        progress: { percentage: 50 },
        lastStageReport: {
          stageId: "catalog",
          status: "pass",
          successCount: 3,
          failCount: 0,
          remainingFilesCount: 0
        },
        stageReports: [
          { stageId: "catalog", status: "pass", successCount: 3, failCount: 0 }
        ],
        checkpoints: [
          { id: "cp_dashboard", phase: "H4", kind: "stage", summary: "ui stage started" }
        ],
        backgroundTaskId: "bg_dashboard",
        backgroundTaskStatus: "running",
        backgroundTaskAttempt: 1
      }
    },
    columns: 120
  }))
  assert.match(output, /LongAgent: running \(H4\)/)
  assert.match(output, /last stage: catalog PASS 3 ok \/ 0 fail/)
  assert.match(output, /recommended: recover-checkpoint cp_dashboard/)
  assert.match(output, /reason: recovery_count=1/)
  assert.match(output, /timeline:/)
  assert.match(output, /stage catalog PASS/)
  assert.match(output, /checkpoint H4 stage ui stage started/)
  assert.match(output, /background running attempt=1/)
})

test("dashboard renders task-center summary when background tasks are present", () => {
  const output = stripAnsi(renderReplDashboard({
    ...baseInput,
    backgroundSummary: {
      total: 3,
      running: 1,
      pending: 1,
      interrupted: 1,
      error: 0,
      completed: 0,
      longagent: 2,
      recovery: 1
    },
    recentBackgroundTasks: [
      "bg_1 longagent running ses_a",
      "bg_2 recovery pending ses_b"
    ],
    columns: 120
  }))
  assert.match(output, /Task Center/)
  assert.match(output, /tasks: total=3 running=1 pending=1 interrupted=1 error=0/)
  assert.match(output, /bg_1 longagent running ses_a/)
})

test("dashboard renders recovery center when recoverable sessions are present", () => {
  const output = stripAnsi(renderReplDashboard({
    ...baseInput,
    recoverableSessions: [
      { id: "ses_recover_1", status: "error", retryable: true },
      { id: "ses_recover_2", status: "running", retryable: false }
    ],
    columns: 120
  }))
  assert.match(output, /Recovery Center/)
  assert.match(output, /recoverable=2/)
  assert.match(output, /ses_recover_1 error retry/)
})

test("dashboard renders provider timeline when present", () => {
  const output = stripAnsi(renderReplDashboard({
    ...baseInput,
    providerSwitches: [
      "provider: anthropic / claude-opus-4-6",
      "resume: openai / gpt-5.3-codex"
    ],
    columns: 120
  }))
  assert.match(output, /Providers/)
  assert.match(output, /timeline:/)
  assert.match(output, /provider: anthropic \/ claude-opus-4-6/)
  assert.match(output, /resume: openai \/ gpt-5.3-codex/)
})

test("logo banner renders without width overflow on narrow terminal", () => {
  const output = renderReplLogo({
    theme: DEFAULT_THEME,
    columns: 80
  })
  for (const line of output.split("\n")) {
    assert.ok(stripAnsi(line).length <= 80, `line overflow: ${stripAnsi(line).length}`)
  }
})

test("startup hint advertises recovery picker", () => {
  const output = renderStartupHint([
    {
      id: "ses_recent_123456",
      mode: "longagent",
      updatedAt: Date.now() - 60_000
    }
  ])
  assert.match(output, /quick resume: \/r ses_recent_1/)
  assert.match(output, /recovery:\s+\/picker or Ctrl\+R/)
})
