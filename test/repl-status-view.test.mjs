import test from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"
import { renderFrameDashboardHeader, renderRuntimeDashboardView, renderStartupScreen } from "../src/ui/repl-status-view.mjs"

function stripAnsi(text) {
  return String(text || "").replace(/\x1B\[[0-9;]*m/g, "")
}

const baseState = {
  sessionId: "ses_demo",
  mode: "agent",
  providerType: "openai",
  model: "gpt-4o-mini",
  memoryLoaded: false
}

test("renderRuntimeDashboardView includes dashboard and runtime summary", () => {
  const text = renderRuntimeDashboardView({
    theme: DEFAULT_THEME,
    state: baseState,
    providers: ["openai"],
    recentSessions: [],
    mcpSummary: { healthy: 0, configured: 0, tools: 0, entries: [] },
    skillSummary: { total: 0, template: 0, skillMd: 0, mcpPrompt: 0, programmable: 0 },
    backgroundSummary: { active: 1, counts: { pending: 1, running: 0, completed: 0, interrupted: 0, error: 0 } },
    runtimeSummary: { messageCount: 12, partCount: 4, recoverableCount: 1, audit: { total: 2, errorCount: 0 } },
    customCommandCount: 0,
    cwd: process.cwd(),
    columns: 100
  })

  assert.match(text, /session=ses_demo/)
  assert.match(text, /background=1 active/)
  assert.match(text, /session.messages=12/)
})

test("renderStartupScreen preserves logo and startup hint output", () => {
  const text = renderStartupScreen({
    theme: DEFAULT_THEME,
    recentSessions: [{ title: "last session", updatedAt: Date.now(), id: "ses_1", mode: "agent" }],
    columns: 100
  })

  assert.ok(stripAnsi(text).includes("last session: ses_1"))
  assert.ok(stripAnsi(text).includes("quick resume: /r ses_1"))
})

test("renderFrameDashboardHeader returns logo lines only when enabled", () => {
  const lines = renderFrameDashboardHeader({
    showDashboard: true,
    theme: DEFAULT_THEME,
    columns: 100
  })
  const none = renderFrameDashboardHeader({
    showDashboard: false,
    theme: DEFAULT_THEME,
    columns: 100
  })

  assert.ok(lines.length > 0)
  assert.equal(none.length, 0)
})
