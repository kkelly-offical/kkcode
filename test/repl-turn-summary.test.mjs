import test from "node:test"
import assert from "node:assert/strict"
import {
  formatRuntimeStateText,
  normalizeDiagnostics,
  normalizeFileChanges,
  renderDiagnosticsLines,
  renderFileChangeLines
} from "../src/ui/repl-turn-summary.mjs"

test("formatRuntimeStateText includes background and skill quickstart lines", () => {
  const text = formatRuntimeStateText(
    {
      sessionId: "ses_1",
      mode: "agent",
      providerType: "openai",
      model: "gpt-test",
      longagentImpl: null
    },
    { healthy: 0, configured: 0, tools: 0, counts: {} },
    { total: 0, template: 0, skillMd: 0, mcpPrompt: 0, programmable: 0 },
    { active: 2, counts: { pending: 1, running: 1, completed: 3, interrupted: 1, error: 0 } }
  )

  assert.match(text, /session=ses_1/)
  assert.match(text, /mcp.quickstart=kkcode mcp init --project/)
  assert.match(text, /skills.quickstart=kkcode skill init --project/)
  assert.match(text, /background=2 active/)
})

test("normalizeFileChanges groups per path and scope", () => {
  const rows = normalizeFileChanges([
    {
      name: "edit",
      args: { path: "src/a.mjs" },
      metadata: {
        fileChanges: [
          { path: "src/a.mjs", addedLines: 2, removedLines: 1, stageId: "s1", taskId: "t1" },
          { path: "src/a.mjs", addedLines: 3, removedLines: 0, stageId: "s1", taskId: "t1" }
        ]
      }
    }
  ])

  assert.equal(rows.length, 1)
  assert.equal(rows[0].addedLines, 5)
  assert.equal(rows[0].removedLines, 1)
})

test("renderDiagnosticsLines emits concise diagnostics summaries", () => {
  const lines = renderDiagnosticsLines([{
    tool: "edit",
    path: "src/a.mjs",
    introduced: 1,
    persistent: 2,
    resolved: 3,
    unchanged: false,
    errorCount: 1,
    warningCount: 0,
    status: "regressed"
  }])

  assert.equal(lines.length, 1)
  assert.match(lines[0], /src\/a\.mjs/)
  assert.match(lines[0], /\+1 \/ 2 \/ -3/)
})

test("renderFileChangeLines emits concise file summaries", () => {
  const lines = renderFileChangeLines([{
    path: "src/a.mjs",
    addedLines: 3,
    removedLines: 1,
    stageId: "s1",
    taskId: "t1"
  }])

  assert.equal(lines.length, 1)
  assert.match(lines[0], /src\/a\.mjs/)
  assert.match(lines[0], /\+3/)
  assert.match(lines[0], /-1/)
})
