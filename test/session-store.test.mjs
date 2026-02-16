import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { appendAssistantMessage, appendPart, appendUserMessage, getSession, touchSession } from "../src/session/store.mjs"

let tmpDir
before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kkcode-test-store-"))
  process.env.KKCODE_HOME = tmpDir
})
after(async () => {
  delete process.env.KKCODE_HOME
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
