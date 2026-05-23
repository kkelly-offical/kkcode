import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { compactSession, buildCompactionPrompt, collectEvidenceLedger, extractCompactionSummary } from "../src/session/compaction.mjs"
import { registerProvider } from "../src/provider/router.mjs"
import { appendAssistantMessage, appendMessage, appendUserMessage, getSession, touchSession } from "../src/session/store.mjs"

let tmpDir
let capturedRequest = null

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kkcode-compaction-test-"))
  process.env.KKCODE_HOME = tmpDir
  registerProvider("compaction-test", {
    request: async (input) => {
      capturedRequest = input
      return {
        text: [
          "<context-state>",
          JSON.stringify({
            goal: "继续优化上下文压缩",
            completed: ["preserved prior state", "captured new failure in src/session/compaction.mjs"],
            in_progress: [],
            files_modified: [{ path: "src/session/compaction.mjs", changes: ["merge-safe context compaction"] }],
            key_decisions: ["merge prior summary instead of summarizing it as chat"],
            errors_resolved: [],
            evidence: ["test failure in src/session/compaction.mjs:42"],
            next_steps: ["run targeted tests"]
          }),
          "</context-state>",
          "<summary>保留旧状态并加入新的失败证据。</summary>"
        ].join("\n"),
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }
      }
    },
    requestStream: async function* () {}
  })
})

after(async () => {
  delete process.env.KKCODE_HOME
  await rm(tmpDir, { recursive: true, force: true })
})

function configState() {
  return {
    config: {
      provider: {
        default: "compaction-test",
        "compaction-test": {
          type: "compaction-test",
          default_model: "test-model",
          api_key_env: "KKCODE_TEST_KEY",
          base_url: "http://127.0.0.1"
        }
      }
    }
  }
}

test("buildCompactionPrompt separates prior summary from conversation delta", () => {
  const prompt = buildCompactionPrompt({
    previousSummary: "<context-state>{\"goal\":\"old\"}</context-state>",
    messages: [{ role: "user", content: "new work" }],
    evidence: ["- role=assistant tool_result ERROR\n  key_lines:\n    Error: boom"]
  })
  assert.match(prompt, /<prior-context-state>/)
  assert.match(prompt, /<conversation-delta>\n\[user\]: new work/)
  assert.match(prompt, /Error: boom/)
})

test("collectEvidenceLedger keeps exact failure lines and paths before pruning", () => {
  const evidence = collectEvidenceLedger([
    {
      role: "assistant",
      content: [{
        type: "tool_result",
        is_error: true,
        content: "noise\nError: failed assertion in src/session/compaction.mjs:42\nmodified package.json\n" + "x".repeat(1500)
      }]
    }
  ])
  assert.equal(evidence.length, 1)
  assert.match(evidence[0], /src\/session\/compaction\.mjs/)
  assert.match(evidence[0], /failed assertion/)
  assert.match(evidence[0], /package\.json/)
})

test("compactSession merges previous summary instead of treating it as transcript", async () => {
  capturedRequest = null
  const sessionId = "ses_compaction_" + Date.now()
  await touchSession({
    sessionId,
    mode: "agent",
    model: "test-model",
    providerType: "compaction-test",
    cwd: process.cwd()
  })
  await appendMessage(sessionId, "user", "<compaction-summary version=\"2\">\n<context-state>{\"goal\":\"old goal\"}</context-state>\n</compaction-summary>")
  await appendUserMessage(sessionId, "please fix context compaction", { turnId: "t1" })
  await appendAssistantMessage(sessionId, [
    { type: "tool_use", id: "toolu_1", name: "test", input: { command: "npm test" } },
    { type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "Error: failed assertion in src/session/compaction.mjs:42\n" + "x".repeat(1000) }
  ], { turnId: "t1", step: 1 })
  await appendUserMessage(sessionId, "continue", { turnId: "t2" })
  await appendAssistantMessage(sessionId, "working", { turnId: "t2" })
  await appendUserMessage(sessionId, "keep going", { turnId: "t3" })
  await appendAssistantMessage(sessionId, "ok", { turnId: "t3" })
  await appendUserMessage(sessionId, "latest task", { turnId: "t4" })
  await appendAssistantMessage(sessionId, "latest answer", { turnId: "t4" })

  const result = await compactSession({
    sessionId,
    model: "test-model",
    providerType: "compaction-test",
    configState: configState(),
    keepRecentTurns: 2
  })

  assert.equal(result.compacted, true)
  assert.ok(capturedRequest)
  const prompt = capturedRequest.messages[0].content
  assert.match(prompt, /<prior-context-state>[\s\S]*old goal/)
  assert.doesNotMatch(prompt, /\[user\]: <compaction-summary/)
  assert.match(prompt, /failed assertion in src\/session\/compaction\.mjs:42/)

  const stored = await getSession(sessionId)
  assert.equal(stored.messages[0].role, "user")
  assert.match(stored.messages[0].content, /<compaction-summary version="2">/)
  assert.match(extractCompactionSummary(stored.messages[0].content), /merge prior summary/)
  assert.equal(stored.messages.some((msg) => msg.content === "latest task"), true)
})
