import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { getConversationHistory, touchSession, appendUserMessage, appendAssistantMessage } from "../src/session/store.mjs"

let tmpDir
before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kkcode-test-hist-"))
  process.env.KKCODE_HOME = tmpDir
})
after(async () => {
  delete process.env.KKCODE_HOME
  await rm(tmpDir, { recursive: true, force: true })
})

test("conversation history returns recent role/content entries", async () => {
  const sessionId = `ses_hist_${Date.now()}`
  await touchSession({
    sessionId,
    mode: "agent",
    model: "gpt-4o-mini",
    providerType: "openai",
    cwd: process.cwd()
  })
  await appendUserMessage(sessionId, "u1")
  await appendAssistantMessage(sessionId, "a1")
  const history = await getConversationHistory(sessionId, 5)
  assert.equal(history.length >= 2, true)
  assert.equal(history[history.length - 1].role, "assistant")
})
