import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { compactSession, buildCompactionPrompt, collectEvidenceLedger, extractCompactionSummary } from "../src/kernel/session/compaction.mjs"
import { registerProvider } from "../src/kernel/provider/router.mjs"
import { appendAssistantMessage, appendMessage, appendUserMessage, getSession, touchSession, flushNow, replaceMessages, replaceConversationForRewind, updateSession } from "../src/kernel/session/store.mjs"

let tmpDir
let previousKkcodeHome
let capturedRequest = null
let beforeProviderResponse = null
let summaryOverride = null

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kkcode-compaction-test-"))
  previousKkcodeHome = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = tmpDir
  registerProvider("compaction-test", {
    request: async (input) => {
      capturedRequest = input
      if (beforeProviderResponse) await beforeProviderResponse()
      return {
        text: summaryOverride ?? [
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
  try { await flushNow() } finally {
    if (previousKkcodeHome === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previousKkcodeHome
  }
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

async function seedConcurrentSession(suffix) {
  const sessionId = `ses_compaction_race_${suffix}`
  await touchSession({ sessionId, mode: 'agent', model: 'test-model', providerType: 'compaction-test', cwd: process.cwd() })
  // A real compaction candidate must be smaller than its source. Keep a long
  // historical prefix so these fixtures exercise CAS, not no-gain rejection.
  for (let i = 0; i < 12; i++) await appendMessage(sessionId, i % 2 ? 'assistant' : 'user', `message-${i}` + (i < 8 ? ' completed context'.repeat(100) : ''), { turnId: `turn-${Math.floor(i / 2)}` })
  return sessionId
}
const compact = sessionId => compactSession({ sessionId, model: 'test-model', providerType: 'compaction-test', configState: configState(), keepRecentTurns: 2 })

for (const change of ['append', 'rewind', 'model']) test(`compaction refuses stale summary after concurrent ${change} without losing messages`, async () => {
  const sessionId = await seedConcurrentSession(change)
  let release, started
  const waiting = new Promise(resolve => { started = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  beforeProviderResponse = async () => { started(); await blocked }
  try {
    const pending = compact(sessionId)
    await waiting
    const observed = await getSession(sessionId)
    if (change === 'append') await appendUserMessage(sessionId, 'New user input must survive')
    if (change === 'rewind') await replaceConversationForRewind(sessionId, observed.messages.slice(0, 4), observed.messages)
    if (change === 'model') await updateSession(sessionId, { model: 'replacement-model' })
    const expected = await getSession(sessionId)
    release()
    const result = await pending
    assert.equal(result.compacted, false)
    assert.match(result.reason, /history changed/)
    const actual = await getSession(sessionId)
    assert.deepEqual(actual.messages, expected.messages)
    assert.equal(actual.session.model, expected.session.model)
  } finally { release(); beforeProviderResponse = null }
})

test('two concurrent compactions commit exactly one observed snapshot', async () => {
  const sessionId = await seedConcurrentSession('double')
  let release, ready
  let count = 0
  const waiting = new Promise(resolve => { ready = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  beforeProviderResponse = async () => { if (++count === 2) ready(); await blocked }
  try {
    const results = Promise.all([compact(sessionId), compact(sessionId)])
    await waiting; release()
    const completed = await results
    assert.equal(completed.filter(result => result.compacted).length, 1)
    const stored = await getSession(sessionId)
    assert.equal(stored.messages.filter(message => typeof message.content === 'string' && message.content.includes('<compaction-summary')).length, 1)
    assert.equal(stored.messages.at(-1).content, 'message-11')
  } finally { release(); beforeProviderResponse = null }
})

test('a nonempty expanding summary cannot replace valid history', async () => {
  const sessionId = await seedConcurrentSession('no_reduction')
  const before = await getSession(sessionId)
  summaryOverride = 'An oversized generated summary. '.repeat(10000)
  try {
    const result = await compact(sessionId)
    assert.equal(result.compacted, false)
    assert.equal(result.reasonCode, 'no_effective_reduction')
    assert.ok(result.estimatedAfterTokens >= result.estimatedBeforeTokens)
    assert.deepEqual((await getSession(sessionId)).messages, before.messages)
  } finally { summaryOverride = null }
})

test('a summary arriving after cancellation and an aborted atomic replacement both preserve history', async () => {
  const sessionId = await seedConcurrentSession('cancelled_summary'), before = await getSession(sessionId), controller = new AbortController()
  beforeProviderResponse = async () => { controller.abort(new Error('host cancelled summary')) }
  try {
    await assert.rejects(compactSession({ sessionId, model: 'test-model', providerType: 'compaction-test', configState: configState(), keepRecentTurns: 2, signal: controller.signal }), /host cancelled summary/)
    assert.deepEqual((await getSession(sessionId)).messages, before.messages)
    await assert.rejects(replaceMessages(sessionId, [{ role: 'user', content: 'must not replace' }], { observedMessages: before.messages, signal: controller.signal }), /host cancelled summary/)
    assert.deepEqual((await getSession(sessionId)).messages, before.messages)
  } finally { beforeProviderResponse = null }
})

async function seedToolHistory(suffix, content) {
  const sessionId = `ses_compaction_pairs_${suffix}`
  await touchSession({ sessionId, mode: 'agent', model: 'test-model', providerType: 'compaction-test', cwd: process.cwd() })
  for (const [index, item] of content.entries()) await appendMessage(sessionId,
    Array.isArray(item) ? (item[0]?.type === 'tool_use' ? 'assistant' : 'user') : (index % 2 ? 'assistant' : 'user'), item)
  return sessionId
}
const prefix = count => Array.from({ length: count }, (_, index) => `old-${index} ` + 'previous verified work '.repeat(100))
const call = id => [{ type: 'tool_use', id, name: 'read', input: { path: `${id}.txt` } }]
const result = id => [{ type: 'tool_result', tool_use_id: id, content: `result-${id}` }]
const tail = count => Array.from({ length: count }, (_, index) => `recent-${index}`)

test('message-count fallback retains the call before a kept result without deleting either', async () => {
  const sessionId = await seedToolHistory('fallback', [...prefix(4), call('paired'), result('paired'), ...tail(5)])
  const before = await getSession(sessionId)
  const compacted = await compact(sessionId)
  assert.equal(compacted.compacted, true)
  assert.equal(compacted.keptCount, 7)
  assert.ok(compacted.estimatedAfterTokens < compacted.estimatedBeforeTokens)
  const after = await getSession(sessionId)
  assert.deepEqual(after.messages.slice(1).map(message => message.id), before.messages.slice(4).map(message => message.id))
  assert.deepEqual(after.messages[1].content, call('paired'))
  assert.deepEqual(after.messages[2].content, result('paired'))
  assert.doesNotMatch(capturedRequest.messages[0].content, /\[tool_use:read/)
})

test('expanding retained suffix follows transitive interleaved tool-result dependencies', async () => {
  const sessionId = await seedToolHistory('parallel', [...prefix(3), call('a'), call('b'), result('a'), result('b'), ...tail(5)])
  const before = await getSession(sessionId)
  const compacted = await compact(sessionId)
  assert.equal(compacted.compacted, true)
  assert.equal(compacted.keptCount, 9)
  assert.deepEqual((await getSession(sessionId)).messages.slice(1).map(message => message.id), before.messages.slice(3).map(message => message.id))
})

test('outstanding first call leaves no safe prefix; orphan results preserve original history rather than being dropped', async () => {
  for (const [name, content, reason] of [
    ['outstanding', [...call('pending').map(block => [block]), ...tail(10)], 'no_safe_boundary'],
    ['orphan', [...prefix(4), result('missing'), ...tail(6)], 'invalid_tool_history']
  ]) {
    const sessionId = await seedToolHistory(name, content)
    const before = await getSession(sessionId)
    capturedRequest = null
    const compacted = await compact(sessionId)
    assert.equal(compacted.compacted, false)
    assert.equal(compacted.reasonCode, reason)
    assert.equal(capturedRequest, null, 'unsafe boundary is found before a summarization request')
    assert.deepEqual((await getSession(sessionId)).messages, before.messages)
  }
})
