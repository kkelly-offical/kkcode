import test from "node:test"
import assert from "node:assert/strict"
import {
  formatRuntimeStateText,
  normalizeDiagnostics,
  normalizeFileChanges,
  renderDiagnosticsLines,
  renderFileChangeLines
} from "../src/ui/repl-turn-summary.mjs"
import { setColorEnabled } from "../src/theme/color.mjs"

test("formatRuntimeStateText includes background and skill quickstart lines", () => {
  const text = formatRuntimeStateText(
    {
      sessionId: "ses_1",
      mode: "agent",
      providerType: "openai",
      model: "gpt-test",
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

test("file change counts follow the theme diff colours, not hardcoded hex", () => {
  // 深浅色终端都成立的前提：红绿计数从 theme.components 取色。
  // setColorEnabled 打开后 paint 才出彩码 —— 主题回归只有在彩码可见时才能断言。
  setColorEnabled(true)
  try {
    const theme = {
      components: { diff_add: "#10a020", diff_del: "#b01020", header: "#334455" }
    }
    const line = renderFileChangeLines([{ path: "a.mjs", addedLines: 2, removedLines: 1 }], 20, theme)[0]
    assert.ok(line.includes("38;2;16;160;32"), `+2 应着主题 diff_add 色: ${JSON.stringify(line)}`)
    assert.ok(line.includes("38;2;176;16;32"), `-1 应着主题 diff_del 色: ${JSON.stringify(line)}`)
    const fallback = renderFileChangeLines([{ path: "a.mjs", addedLines: 1, removedLines: 0 }], 20, null)[0]
    assert.ok(fallback.includes("38;2;0;255;0") || fallback.includes("+1"), "无主题时保留原硬编码回落")
  } finally {
    setColorEnabled(null)
  }
})

test("diagnostics labels fall back gracefully without a theme", () => {
  const lines = renderDiagnosticsLines([{ path: "x.mjs", introduced: 0, persistent: 1, resolved: 0, errorCount: 0, warningCount: 1, status: "" }], 10, null)
  assert.match(lines[0], /x\.mjs/)
})
