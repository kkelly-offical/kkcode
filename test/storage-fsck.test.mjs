import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  touchSession,
  appendUserMessage,
  fsckSessionStore,
  gcSessionStore,
  flushNow,
  configureSessionStore
} from "../src/session/store.mjs"
import { sessionDataPath, ensureSessionShardRoot } from "../src/storage/paths.mjs"
import { writeJson } from "../src/storage/json-store.mjs"

let home = ""

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kkcode-storage-fsck-"))
  process.env.KKCODE_HOME = home
  configureSessionStore({ flushIntervalMs: 0 })
})

afterEach(async () => {
  await flushNow()
  delete process.env.KKCODE_HOME
  await rm(home, { recursive: true, force: true })
})

test("fsck reports healthy store on clean data", async () => {
  const sessionId = `ses_fsck_${Date.now()}`
  await touchSession({
    sessionId,
    mode: "agent",
    model: "gpt-4o-mini",
    providerType: "openai",
    cwd: process.cwd()
  })
  await appendUserMessage(sessionId, "hello")
  await flushNow()

  const report = await fsckSessionStore()
  assert.equal(report.ok, true)
  assert.equal(report.missingDataFiles.length, 0)
  assert.equal(report.orphanDataFiles.length, 0)
})

test("gc removes orphan session files found by fsck", async () => {
  await ensureSessionShardRoot()
  const orphanId = `ses_orphan_${Date.now()}`
  await writeJson(sessionDataPath(orphanId), { messages: [], parts: [] })

  const report = await fsckSessionStore()
  assert.equal(report.ok, false)
  assert.ok(report.orphanDataFiles.includes(orphanId))

  const out = await gcSessionStore({ orphansOnly: true })
  assert.ok(out.removed.orphanFiles.includes(orphanId))

  const reportAfter = await fsckSessionStore()
  assert.equal(reportAfter.orphanDataFiles.includes(orphanId), false)
})
