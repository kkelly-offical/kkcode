import test from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"
import { renderReplDashboard, renderReplLogo } from "../src/ui/repl-dashboard.mjs"

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

test("logo banner renders without width overflow on narrow terminal", () => {
  const output = renderReplLogo({
    theme: DEFAULT_THEME,
    columns: 80
  })
  for (const line of output.split("\n")) {
    assert.ok(stripAnsi(line).length <= 80, `line overflow: ${stripAnsi(line).length}`)
  }
})
