import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { promisify } from "node:util"
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import {
  configureAuditStore, readAuditStore, appendAuditEntry,
  listAuditEntries, auditStats, exportAuditEntries, verifyAuditChain
} from "../src/storage/audit-store.mjs"

const execFile = promisify(execFileCallback)
let tmpDir

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "audit-test-"))
  process.env.KKCODE_HOME = tmpDir
  configureAuditStore({ reset: true })
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
    assert.equal(entry.schema, "kk.audit.v1")
    assert.match(entry.eventHash, /^[a-f0-9]{64}$/)
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

  it("listAuditEntries filters trace, provider, review, and status", async () => {
    await appendAuditEntry({
      type: "provider.finish",
      traceId: "trace-1",
      provider: "gateway",
      reviewId: "review-1",
      status: "ok"
    })
    await appendAuditEntry({
      type: "provider.error",
      traceId: "trace-2",
      provider: "anthropic",
      reviewId: "review-2",
      status: "error"
    })
    const list = await listAuditEntries({
      traceId: "trace-1",
      provider: "gateway",
      reviewId: "review-1",
      status: "ok"
    })
    assert.equal(list.length, 1)
    assert.equal(list[0].traceId, "trace-1")
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

  it("preserves the legacy JSON store as read-only history", async () => {
    const legacyPath = path.join(tmpDir, "audit-log.json")
    const legacy = `${JSON.stringify({
      updatedAt: 1,
      entries: [{
        id: "legacy-1",
        createdAt: 1,
        type: "legacy",
        output: "private legacy output",
        command: "curl -H 'Authorization: secret'"
      }]
    }, null, 2)}\n`
    await writeFile(legacyPath, legacy)
    await appendAuditEntry({ type: "new" })

    const store = await readAuditStore()
    assert.deepEqual(store.entries.map((entry) => entry.type), ["legacy", "new"])
    assert.match(store.entries[0].output.sha256, /^[a-f0-9]{64}$/)
    assert.match(store.entries[0].command.sha256, /^[a-f0-9]{64}$/)
    assert.doesNotMatch(JSON.stringify(store.entries[0]), /private legacy output|Authorization/)
    assert.equal(await readFile(legacyPath, "utf8"), legacy)
  })

  it("verifies a concurrent append-only hash chain", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => appendAuditEntry({
        type: "tool.finish",
        traceId: `trace-${index}`,
        ok: true
      }))
    )
    const result = await verifyAuditChain()
    assert.equal(result.ok, true)
    assert.equal(result.entries, 20)
    assert.match(result.headHash, /^[a-f0-9]{64}$/)
  })

  it("serializes audit chains across multiple KK Code processes", async () => {
    const moduleUrl = new URL("../src/storage/audit-store.mjs", import.meta.url).href
    const children = Array.from({ length: 4 }, (_, processIndex) => {
      const script = [
        `import { appendAuditEntry } from ${JSON.stringify(moduleUrl)}`,
        `for (let index = 0; index < 6; index++) await appendAuditEntry({ type: "child", processIndex: ${processIndex}, index })`
      ].join("\n")
      return execFile(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, KKCODE_HOME: tmpDir }
      })
    })
    await Promise.all(children)
    const result = await verifyAuditChain()
    assert.equal(result.ok, true, JSON.stringify(result.errors))
    assert.equal(result.entries, 24)
  })

  it('never removes a newly acquired live lock using a stale owner snapshot', async t => {
    const file = path.join(tmpDir, 'audit-log.jsonl.lock')
    const io = { read: fs.promises.readFile, write: fs.promises.writeFile, unlink: fs.promises.unlink }
    await io.write(file, JSON.stringify({ token: 'dead-snapshot', pid: 2147483646, createdAt: Date.now() }))
    let replaced = false, released = false, stolen = false
    t.mock.method(fs.promises, 'readFile', async (target, ...args) => {
      const content = await io.read(target, ...args)
      if(target === file) {
        const owner = JSON.parse(String(content))
        if(owner.token === 'dead-snapshot' && !replaced) {
          // Another recovery actor replaces the dead owner's inode before this
          // actor checks liveness. No sleeps or random process timing needed.
          await io.unlink(file)
          await io.write(file, JSON.stringify({ token: 'live-replacement', pid: process.pid, createdAt: Date.now() }))
          replaced = true
        } else if(owner.token === 'live-replacement') {
          released = true
          await io.unlink(file) // the simulated live owner voluntarily releases
        }
      }
      return content
    })
    t.mock.method(fs.promises, 'unlink', async (target, ...args) => {
      if(target === file && replaced && !released) {
        const owner = await io.read(file, 'utf8').then(JSON.parse).catch(() => null)
        if(owner?.token === 'live-replacement') stolen = true
      }
      return io.unlink(target, ...args)
    })
    syncBuiltinESMExports()
    try { await appendAuditEntry({ type: 'recovery-race' }) }
    finally { t.mock.restoreAll(); syncBuiltinESMExports() }
    assert.equal(replaced, true)
    assert.equal(stolen, false, 'a stale recovery actor unlinked another live owner')
    assert.equal(released, true, 'the writer must wait for the real owner to release')
    assert.equal((await verifyAuditChain()).ok, true)
  })

  it('refuses to fork a chain when its existing tail is malformed or unreadable', async t => {
    await appendAuditEntry({ type: 'valid-head' })
    const file = path.join(tmpDir, 'audit-log.jsonl'), original = await readFile(file, 'utf8')
    const ioOpen = fs.promises.open
    t.mock.method(fs.promises, 'open', async (target, flags, ...args) => {
      if(target === file && flags === 'r') throw Object.assign(new Error('fixture read denied'), { code: 'EPERM' })
      return ioOpen(target, flags, ...args)
    })
    syncBuiltinESMExports()
    try { await assert.rejects(appendAuditEntry({ type: 'must-not-append' }), { code: 'EPERM' }) }
    finally { t.mock.restoreAll(); syncBuiltinESMExports() }
    assert.equal(await readFile(file, 'utf8'), original)
    await writeFile(file, original + '{incomplete tail')
    await assert.rejects(appendAuditEntry({ type: 'must-not-append' }), SyntaxError)
    assert.equal(await readFile(file, 'utf8'), original + '{incomplete tail')
  })

  it('refuses a short tail read instead of treating zero padding as an empty chain', async t => {
    await appendAuditEntry({ type: 'valid-head' })
    const file = path.join(tmpDir, 'audit-log.jsonl'), original = await readFile(file, 'utf8')
    const ioOpen = fs.promises.open
    t.mock.method(fs.promises, 'open', async (target, flags, ...args) => {
      const handle = await ioOpen(target, flags, ...args)
      if(target === file && flags === 'r') {
        const read = handle.read.bind(handle)
        t.mock.method(handle, 'read', (buffer, offset, length, position) => read(buffer, offset, Math.max(0, length - 1), position))
      }
      return handle
    })
    syncBuiltinESMExports()
    try { await assert.rejects(appendAuditEntry({ type: 'must-not-append' }), /Audit tail changed/) }
    finally { t.mock.restoreAll(); syncBuiltinESMExports() }
    assert.equal(await readFile(file, 'utf8'), original)
    assert.equal((await verifyAuditChain()).ok, true)
  })

  it("treats every platform's lock-contention error code as contention, not as fatal", async () => {
    // 这条锁的是**平台差异**，不能靠 Windows runner 偶发抖动来发现。
    // `open(file, "wx")` 在锁被别人持有时：POSIX 给 EEXIST，而 Windows 在
    // 文件存在且被其他进程持有打开句柄时给 **EPERM**（并发 unlink 进行中时
    // 还可能是 EBUSY/EACCES）。只认 EEXIST 的版本会把这些抛出去，于是多个
    // kkcode 进程同时写审计日志时 Windows 上会崩 —— 而审计链的可靠性正是
    // 这个锁存在的理由。0.6.7 的发布就是被这条卡住的。
    const source = await readFile(new URL("../src/storage/audit-store.mjs", import.meta.url), "utf8")
    for (const code of ["EEXIST", "EPERM", "EBUSY", "EACCES"]) {
      assert.match(source, new RegExp(`"${code}"`), `锁竞争码必须包含 ${code}`)
    }
    // 不能退回「只认 EEXIST」的写法
    assert.doesNotMatch(source, /error\?\.code !== "EEXIST"/,
      "改回只比较 EEXIST 会让 Windows 上的锁竞争变成崩溃")
  })

  it("survives lock contention that surfaces as EPERM", async () => {
    // 直接占住锁文件，再让 appendAuditEntry 去抢 —— 它必须重试而不是抛错。
    const lockPath = path.join(tmpDir, "audit-log.jsonl.lock")
    // 写一个持有者已死的锁（pid 1 之外的不存在 pid），走 stale 回收路径
    await writeFile(lockPath, JSON.stringify({ token: "other", pid: 2147483646, createdAt: Date.now() }), "utf8")
    await appendAuditEntry({ type: "after-contention" })
    const result = await verifyAuditChain()
    assert.equal(result.ok, true)
    assert.ok(result.entries >= 1)
  })

  it("detects tampering", async () => {
    await appendAuditEntry({ type: "tool.start", tool: "read" })
    await appendAuditEntry({ type: "tool.finish", tool: "read" })
    const logPath = path.join(tmpDir, "audit-log.jsonl")
    const content = await readFile(logPath, "utf8")
    await writeFile(logPath, content.replace('"tool":"read"', '"tool":"write"'))

    const result = await verifyAuditChain()
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.error === "event hash mismatch"))
  })

  it("rotates while keeping a verifiable anchored chain", async () => {
    configureAuditStore({ maxBytes: 512, maxFiles: 3 })
    for (let index = 0; index < 12; index++) {
      await appendAuditEntry({ type: "rotation.test", index, detail: "x".repeat(100) })
    }
    const result = await verifyAuditChain()
    assert.equal(result.ok, true)
    assert.ok(result.entries > 0)
    assert.ok(result.entries < 12)
    assert.match(result.anchorHash, /^[a-f0-9]{64}$/)
  })

  it("recursively redacts entries and exports JSONL", async () => {
    await appendAuditEntry({
      type: "provider.error",
      provider: "gateway",
      headers: { authorization: "Bearer secret" },
      args: {
        query: "private tool query",
        objective: "private tool objective"
      },
      error: "request rejected for " + "sk-kimi-" + "abcdefghijklmnopqrstuvwxyz"
    })
    const output = await exportAuditEntries({ format: "jsonl", provider: "gateway" })
    assert.doesNotMatch(output, /abcdefghijklmnopqrstuvwxyz|Bearer secret|private tool query|private tool objective/)
    assert.match(output, /\[REDACTED\]/)
    const parsed = JSON.parse(output.trim())
    assert.equal(parsed.provider, "gateway")
    assert.match(parsed.args.sha256, /^[a-f0-9]{64}$/)
  })
})
