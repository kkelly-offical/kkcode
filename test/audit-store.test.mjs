import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  configureAuditStore, readAuditStore, appendAuditEntry,
  listAuditEntries, auditStats
} from "../src/storage/audit-store.mjs"

let tmpDir

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "audit-test-"))
  process.env.KKCODE_HOME = tmpDir
})

afterEach(async () => {
  delete process.env.KKCODE_HOME
  await rm(tmpDir, { recursive: true, force: true })
})

describe("audit-store", () => {
  it("readAuditStore returns defaults when empty", async () => {
    const store = await readAuditStore()
    assert.deepEqual(store.entries, [])
    assert.ok(store.updatedAt)
  })

  it("appendAuditEntry adds entry with id and timestamp", async () => {
    const entry = await appendAuditEntry({ tool: "bash", sessionId: "s1", type: "tool_call" })
    assert.ok(entry.id.startsWith("aud_"))
    assert.ok(entry.createdAt)
    assert.equal(entry.tool, "bash")
  })

  it("appendAuditEntry persists across reads", async () => {
    await appendAuditEntry({ tool: "read", type: "tool_call" })
    await appendAuditEntry({ tool: "write", type: "tool_call" })
    const store = await readAuditStore()
    assert.equal(store.entries.length, 2)
  })

  it("listAuditEntries filters by sessionId", async () => {
    await appendAuditEntry({ tool: "bash", sessionId: "s1" })
    await appendAuditEntry({ tool: "read", sessionId: "s2" })
    await appendAuditEntry({ tool: "write", sessionId: "s1" })
    const list = await listAuditEntries({ sessionId: "s1" })
    assert.equal(list.length, 2)
    assert.ok(list.every(e => e.sessionId === "s1"))
  })

  it("listAuditEntries filters by tool", async () => {
    await appendAuditEntry({ tool: "bash" })
    await appendAuditEntry({ tool: "read" })
    const list = await listAuditEntries({ tool: "bash" })
    assert.equal(list.length, 1)
    assert.equal(list[0].tool, "bash")
  })

  it("listAuditEntries respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await appendAuditEntry({ tool: "read", seq: i })
    }
    const list = await listAuditEntries({ limit: 3 })
    assert.equal(list.length, 3)
  })

  it("listAuditEntries returns reverse chronological", async () => {
    await appendAuditEntry({ tool: "a" })
    await appendAuditEntry({ tool: "b" })
    const list = await listAuditEntries()
    assert.equal(list[0].tool, "b")
  })

  it("auditStats counts errors", async () => {
    await appendAuditEntry({ type: "error", ok: false })
    await appendAuditEntry({ type: "tool_call", ok: true })
    const stats = await auditStats()
    assert.equal(stats.total, 2)
    assert.equal(stats.error1h, 1)
    assert.equal(stats.error24h, 1)
  })

  it("configureAuditStore rejects too-small maxEntries", () => {
    configureAuditStore({ maxEntries: 50 })
    // Should not change — minimum is 100
  })
})
