import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import hook from "../src/plugin/builtin-hooks/post-edit-typecheck.mjs"
import {
  buildEditDiagnosticsReport,
  buildMutationObservability,
  collectDiagnosticsSnapshot,
  diffDiagnostics,
  extractEditFeedbackFromToolEvents
} from "../src/observability/edit-diagnostics.mjs"

test("diffDiagnostics separates added, persisted, and resolved diagnostics", () => {
  const baseline = [
    { provider: "node-syntax", file: "a.mjs", severity: "error", code: "node-check", message: "unexpected token", line: 1, column: null },
    { provider: "node-syntax", file: "b.mjs", severity: "error", code: "node-check", message: "missing )", line: 3, column: null }
  ]
  const current = [
    { provider: "node-syntax", file: "b.mjs", severity: "error", code: "node-check", message: "missing )", line: 3, column: null },
    { provider: "node-syntax", file: "c.mjs", severity: "error", code: "node-check", message: "bad export", line: 5, column: null }
  ]

  const delta = diffDiagnostics(baseline, current)
  assert.equal(delta.added.length, 1)
  assert.equal(delta.persisted.length, 1)
  assert.equal(delta.resolved.length, 1)
  assert.equal(delta.added[0].file, "c.mjs")
  assert.equal(delta.persisted[0].file, "b.mjs")
  assert.equal(delta.resolved[0].file, "a.mjs")
})

test("collectDiagnosticsSnapshot reports node syntax failures for edited JavaScript files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kkcode-edit-diagnostics-"))
  try {
    await writeFile(join(cwd, "broken.mjs"), "export const answer = ;\n", "utf8")
    await writeFile(join(cwd, "ok.mjs"), "export const answer = 42\n", "utf8")

    const snapshot = await collectDiagnosticsSnapshot({
      cwd,
      files: ["broken.mjs", "ok.mjs"]
    })

    assert.equal(snapshot.available, true)
    assert.equal(snapshot.diagnostics.length, 1)
    assert.equal(snapshot.diagnostics[0].provider, "node-syntax")
    assert.equal(snapshot.diagnostics[0].file, "broken.mjs")
    assert.ok(snapshot.providers.some((provider) => provider.name === "node-syntax" && provider.available))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("buildEditDiagnosticsReport summarizes regression and improvement states", () => {
  const regressed = buildEditDiagnosticsReport({
    files: ["demo.mjs"],
    baseline: { available: true, diagnostics: [] },
    current: {
      available: true,
      diagnostics: [
        { provider: "node-syntax", file: "demo.mjs", severity: "error", code: "node-check", message: "bad syntax", line: 1, column: null }
      ]
    }
  })
  assert.equal(regressed.summary.status, "regressed")
  assert.equal(regressed.delta.added.length, 1)

  const improved = buildEditDiagnosticsReport({
    files: ["demo.mjs"],
    baseline: {
      available: true,
      diagnostics: [
        { provider: "node-syntax", file: "demo.mjs", severity: "error", code: "node-check", message: "bad syntax", line: 1, column: null }
      ]
    },
    current: { available: true, diagnostics: [] }
  })
  assert.equal(improved.summary.status, "improved")
  assert.equal(improved.delta.resolved.length, 1)
})

test("buildMutationObservability and extractEditFeedbackFromToolEvents expose reusable edit feedback shape", () => {
  const observability = buildMutationObservability({
    mutation: {
      operation: "edit",
      filePath: "src/demo.mjs",
      addedLines: 3,
      removedLines: 1
    }
  })

  assert.equal(observability.totals.filesChanged, 1)
  assert.match(observability.summary, /1 file changed via edit/)

  const feedback = extractEditFeedbackFromToolEvents([{
    name: "edit",
    status: "completed",
    args: { path: "src/demo.mjs" },
    metadata: {
      mutation: {
        operation: "edit",
        filePath: "src/demo.mjs",
        addedLines: 3,
        removedLines: 1
      },
      diagnostics: {
        contract: "kkcode/edit-diagnostics@1",
        files: ["src/demo.mjs"],
        summary: { status: "clean", text: "clean (no diagnostics before or after)" }
      }
    }
  }])

  assert.equal(feedback.length, 1)
  assert.equal(feedback[0].tool, "edit")
  assert.equal(feedback[0].files[0], "src/demo.mjs")
  assert.equal(feedback[0].diagnostics.summary.status, "clean")
})

test("post-edit hook attaches diagnostics delta and mutation observability", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kkcode-post-edit-observability-"))
  const file = join(cwd, "demo.mjs")

  try {
    await writeFile(file, "export const value = 1\n", "utf8")

    const beforePayload = await hook.tool.before({
      tool: "write",
      toolName: "write",
      args: { path: "demo.mjs" },
      cwd,
      sessionId: "ses_test",
      step: 1
    })

    await writeFile(file, "export const value = (\n", "utf8")

    const afterPayload = await hook.tool.after({
      ...beforePayload,
      tool: "write",
      toolName: "write",
      args: { path: "demo.mjs" },
      cwd,
      sessionId: "ses_test",
      step: 1,
      result: {
        name: "write",
        status: "completed",
        output: "written: demo.mjs",
        metadata: {
          fileChanges: [{ path: "demo.mjs", tool: "write", addedLines: 1, removedLines: 1 }],
          mutation: {
            operation: "write",
            filePath: "demo.mjs",
            addedLines: 1,
            removedLines: 1
          }
        }
      }
    })

    const diagnostics = afterPayload.result.metadata.diagnostics
    assert.ok(diagnostics)
    assert.equal(diagnostics.delta.added.length, 1)
    assert.equal(diagnostics.baseline.count, 0)
    assert.equal(afterPayload.result.metadata.observability.totals.filesChanged, 1)
    assert.match(afterPayload.result.output, /Mutation summary:/)
    assert.match(afterPayload.result.output, /Diagnostics:/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
