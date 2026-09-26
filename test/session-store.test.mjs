import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { appendAssistantMessage, appendPart, appendUserMessage, getSession, touchSession, flushNow } from "../src/kernel/session/store.mjs"

let tmpDir
let previousKkcodeHome
before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kkcode-test-store-"))
  previousKkcodeHome = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = tmpDir
})
after(async () => {
  try { await flushNow() } finally {
    if (previousKkcodeHome === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previousKkcodeHome
  }
  await rm(tmpDir, { recursive: true, force: true })
})

test("session store persists session/messages/parts", async () => {
  const sessionId = `ses_store_${Date.now()}`
  await touchSession({
    sessionId,
    mode: "agent",
    model: "gpt-4o-mini",
    providerType: "openai",
    cwd: process.cwd()
  })
  const user = await appendUserMessage(sessionId, "hello")
  const assistant = await appendAssistantMessage(sessionId, "world")
  await appendPart(sessionId, { type: "tool-call", messageId: user.id, tool: "list", ok: true, output: "done" })
  const data = await getSession(sessionId)
  assert.ok(data)
  assert.equal(data.messages.length >= 2, true)
  assert.equal(data.parts.length >= 1, true)
  assert.equal(data.messages.some((m) => m.id === assistant.id), true)
})

test('session shard names reject traversal, coercion and prototype keys before queuing data', async () => {
  for (const sessionId of ['../outside', '..\\outside', '/outside', '%2e%2e', 'safe\n', 'safe\r', 'safe\u2028', 'safe\0', 'a'.repeat(129), '__proto__', 'constructor', 'prototype', '', {}, [], null]) {
    await assert.rejects(appendUserMessage(sessionId, 'must not persist'), { code: 'invalid_session' })
  }
  const sessionId = 's'.repeat(128)
  await touchSession({ sessionId, mode: 'agent', model: 'fixture' })
  await appendUserMessage(sessionId, 'valid boundary')
  assert.equal((await getSession(sessionId)).messages[0].content, 'valid boundary')
})
