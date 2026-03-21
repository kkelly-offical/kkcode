import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { access } from "node:fs/promises"
import { appendAssistantMessage, appendPart, appendUserMessage, configureSessionStore, flushNow, getSession, touchSession } from "../src/session/store.mjs"

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

test("flushNow cancels pending scheduled flushes", async () => {
  configureSessionStore({ flushIntervalMs: 50 })
  const sessionId = `ses_flush_${Date.now()}`
  await touchSession({
    sessionId,
    mode: "agent",
    model: "gpt-4o-mini",
    providerType: "openai",
    cwd: process.cwd()
  })

  await flushNow()

  const redirectedHome = await mkdtemp(join(tmpdir(), "kkcode-test-store-redirect-"))
  process.env.KKCODE_HOME = redirectedHome

  try {
    await new Promise((resolve) => setTimeout(resolve, 120))
    await assert.rejects(
      access(join(redirectedHome, "sessions", `${sessionId}.json`)),
      () => true
    )
  } finally {
    process.env.KKCODE_HOME = tmpDir
    configureSessionStore({ flushIntervalMs: 1000 })
    await rm(redirectedHome, { recursive: true, force: true })
  }
})

test("session store resets in-memory state when KKCODE_HOME changes", async () => {
  configureSessionStore({ flushIntervalMs: 1000 })
  const firstSessionId = `ses_home_a_${Date.now()}`
  await touchSession({
    sessionId: firstSessionId,
    mode: "agent",
    model: "gpt-4o-mini",
    providerType: "openai",
    cwd: process.cwd()
  })
  await flushNow()

  const redirectedHome = await mkdtemp(join(tmpdir(), "kkcode-test-store-root-"))
  process.env.KKCODE_HOME = redirectedHome

  try {
    const secondSessionId = `ses_home_b_${Date.now()}`
    await touchSession({
      sessionId: secondSessionId,
      mode: "agent",
      model: "gpt-4o-mini",
      providerType: "openai",
      cwd: process.cwd()
    })
    await flushNow()

    const firstInNewHome = await getSession(firstSessionId)
    const secondInNewHome = await getSession(secondSessionId)
    assert.equal(firstInNewHome, null)
    assert.ok(secondInNewHome)
  } finally {
    process.env.KKCODE_HOME = tmpDir
    await rm(redirectedHome, { recursive: true, force: true })
  }
})
