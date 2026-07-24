import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  sanitizeAuditMetadata,
  startAuditSpan,
  summarizeAuditContent
} from "../src/audit/event.mjs"
import {
  configureAuditStore,
  listAuditEntries,
  verifyAuditChain
} from "../src/storage/audit-store.mjs"
import { PermissionEngine } from "../src/permission/engine.mjs"

test("audit metadata stores content hashes instead of content", () => {
  const result = sanitizeAuditMetadata({
    body: "private prompt",
    args: {
      query: "private search query",
      text: "private tool text",
      objective: "private objective"
    },
    nested: { api_key: "sk-secret", model: "k3" }
  })
  assert.deepEqual(result.body, summarizeAuditContent("private prompt"))
  assert.deepEqual(result.args, summarizeAuditContent({
    query: "private search query",
    text: "private tool text",
    objective: "private objective"
  }))
  assert.equal(result.nested.api_key, "[REDACTED]")
  assert.equal(result.nested.model, "k3")
  assert.doesNotMatch(JSON.stringify(result), /private prompt|private search|private tool|private objective|sk-secret/)
})

test("audit spans correlate start and finish events", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "audit-span-"))
  process.env.KKCODE_HOME = tmpDir
  configureAuditStore({ reset: true })
  try {
    const span = await startAuditSpan({
      type: "provider.request",
      provider: "gateway",
      protocol: "openai",
      model: "model-a"
    })
    await span.finish({
      usage: { input: 5, output: 2 },
      response: "private model output"
    })

    const entries = (await listAuditEntries({ traceId: span.traceId })).reverse()
    assert.equal(entries.length, 2)
    assert.equal(entries[1].parentEventId, entries[0].eventId)
    assert.equal(entries[0].requestId, entries[1].requestId)
    assert.equal(entries[1].provider, "gateway")
    assert.equal(entries[1].model, "model-a")
    assert.deepEqual(entries[1].response, summarizeAuditContent("private model output"))
    assert.equal((await verifyAuditChain()).ok, true)
  } finally {
    delete process.env.KKCODE_HOME
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test("permission audit events inherit review and trace correlation", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "audit-permission-"))
  process.env.KKCODE_HOME = tmpDir
  configureAuditStore({ reset: true })
  PermissionEngine.setTrusted(true)
  try {
    await PermissionEngine.check({
      config: {
        permission: {
          level: "manual",
          rules: [{ tool: "github_publish", action: "allow" }]
        }
      },
      sessionId: "review-audit-session",
      traceId: "trace-review-audit",
      requestId: "request-review-audit",
      reviewId: "review-audit",
      tool: "github_publish",
      mode: "agent",
      pattern: "https://github.com/example/repo/pull/1"
    })

    const entries = await listAuditEntries({ reviewId: "review-audit" })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].type, "permission.decided")
    assert.equal(entries[0].traceId, "trace-review-audit")
    assert.equal(entries[0].requestId, "request-review-audit")
  } finally {
    PermissionEngine.setTrusted(false)
    delete process.env.KKCODE_HOME
    await rm(tmpDir, { recursive: true, force: true })
  }
})
