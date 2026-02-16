import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { touchSession, listSessions, getConversationHistory, appendUserMessage, appendAssistantMessage } from "../src/session/store.mjs"

let tmpDir
before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kkcode-test-repl-session-"))
  process.env.KKCODE_HOME = tmpDir
})
after(async () => {
  delete process.env.KKCODE_HOME
  await rm(tmpDir, { recursive: true, force: true })
})

test("listSessions returns sessions sorted by updatedAt desc", async () => {
  const cwd = process.cwd()
  await touchSession({ sessionId: "ses_a", mode: "ask", model: "m1", providerType: "openai", cwd })
  await new Promise((r) => setTimeout(r, 20))
  await touchSession({ sessionId: "ses_b", mode: "agent", model: "m2", providerType: "openai", cwd })

  const sessions = await listSessions({ cwd, limit: 5, includeChildren: false })
  assert.ok(sessions.length >= 2)
  assert.equal(sessions[0].id, "ses_b")
  assert.equal(sessions[1].id, "ses_a")
})

test("listSessions respects limit", async () => {
  const sessions = await listSessions({ cwd: process.cwd(), limit: 1, includeChildren: false })
  assert.equal(sessions.length, 1)
})

test("resume flow: touchSession -> listSessions -> getConversationHistory", async () => {
  const sid = "ses_resume_test"
  const cwd = process.cwd()
  await touchSession({ sessionId: sid, mode: "agent", model: "gpt-4o-mini", providerType: "openai", cwd })
  await appendUserMessage(sid, "hello from user")
  await appendAssistantMessage(sid, "hello from assistant")

  const sessions = await listSessions({ cwd, limit: 10, includeChildren: false })
  const target = sessions.find((s) => s.id === sid)
  assert.ok(target)
  assert.equal(target.mode, "agent")

  const msgs = await getConversationHistory(sid, 3)
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].role, "user")
  assert.equal(msgs[0].content, "hello from user")
  assert.equal(msgs[1].role, "assistant")
  assert.equal(msgs[1].content, "hello from assistant")
})

test("listSessions excludes child sessions when includeChildren=false", async () => {
  const cwd = process.cwd()
  await touchSession({ sessionId: "ses_parent", mode: "agent", model: "m1", providerType: "openai", cwd })
  await touchSession({ sessionId: "ses_child", mode: "agent", model: "m1", providerType: "openai", cwd, parentSessionId: "ses_parent" })

  const sessions = await listSessions({ cwd, limit: 50, includeChildren: false })
  const childFound = sessions.find((s) => s.id === "ses_child")
  assert.equal(childFound, undefined)
})

test("prefix match for resume works", async () => {
  const cwd = process.cwd()
  const sid = "ses_prefix_match_12345"
  await touchSession({ sessionId: sid, mode: "plan", model: "m1", providerType: "openai", cwd })

  const sessions = await listSessions({ cwd, limit: 50, includeChildren: false })
  const prefix = "ses_prefix_m"
  const target = sessions.find((s) => s.id === sid || s.id.startsWith(prefix))
  assert.ok(target)
  assert.equal(target.id, sid)
})
