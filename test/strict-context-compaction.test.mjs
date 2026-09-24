import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createKernel } from '../src/kernel/index.mjs'
import { createArtifactStore } from '../src/storage/artifact-store.mjs'
import { prepareBudgetProfiles } from '../src/usage/budget-profiles.mjs'
import { withRequestBudget } from '../src/usage/request-budget.mjs'
import { strictInputTokenBound } from '../src/usage/input-token-bound.mjs'
import { requestContextBudget } from '../src/kernel/session/context-budget.mjs'
import { createFixtureCleanup } from './helpers/fixture-cleanup.mjs'

const LIMIT = 262144
const USER_CONSTRAINT = 'NEW_USER_CONSTRAINT: original.txt must remain byte-identical.'
const summary = '<context-state>{"goal":"Continue safely","next_steps":["preserve original.txt"]}</context-state>\n<summary>Earlier completed work and archived tool evidence were reviewed.</summary>'
async function fixture(t, { summaryFailure = false, concurrentAppend = false, abortSummary = false, unicodeExpansion = false, opaqueHistory = false, contextLimit = LIMIT, maxTokens = 4096 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-strict-context-')), cleanup = createFixtureCleanup(t), previous = process.env.KKCODE_HOME
  cleanup.remove(root); cleanup.defer(() => { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous })
  process.env.KKCODE_HOME = path.join(root, 'private')
  const requests = [], events = []
  let kernel, appends = 0
  const controller = new AbortController()
  const sessionId = 'strict-context-fixture'
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString()), summarizing = JSON.stringify(body.messages[0]?.content).includes('conversation summarizer')
    requests.push({ body, summarizing })
    if (summarizing && concurrentAppend && appends++ === 0) await kernel.sessions.appendUserMessage(sessionId, 'CONCURRENT_USER_CONSTRAINT must survive the stale summary.', { turnId: 'arriving-user' })
    if (summarizing && abortSummary) { controller.abort(new Error('Synthetic user cancellation during summary HTTP')); await new Promise(resolve => setTimeout(resolve, 100)) }
    response.setHeader('content-type', 'application/json')
    if (summarizing && summaryFailure) { response.statusCode = 503; response.end(JSON.stringify({ error: { message: 'Synthetic summarizer unavailable' } })); return }
    response.end(JSON.stringify({ id: `fixture-${requests.length}`, model: 'fixed-model', choices: [{ index: 0, message: { role: 'assistant', content: summarizing ? unicodeExpansion ? `<summary>${'ﷺ'.repeat(5000)}</summary>` : summary : 'CONTINUED_INSIDE_ORIGINAL_WINDOW' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }))
  })
  cleanup.defer(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const pricing = path.join(root, 'prices.json')
  await writeFile(pricing, JSON.stringify({ models: { 'fixed-model': { input: 1, output: 2, cache_read: 1, cache_write: 1 } } }))
  const configState = { source: { userDir: root, userRaw: { usage: { pricing_file: pricing } } }, config: {
    provider: { default: 'fixture', fixture: { type: 'openai', base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key: '', api_key_env: '', default_model: 'fixed-model', context_limit: contextLimit, max_tokens: maxTokens, stream: false, retry_attempts: 0, model_capabilities: { 'fixed-model': { image: true, tool_call: true } } } },
    agent: { default_mode: 'agent', max_steps: 4, verify_completion: false }, permission: { level: 'accept-edits', rules: [] },
    session: { recovery: false, title_generation: false, compaction_threshold_ratio: 0.85, compaction_threshold_messages: 200 },
    skills: { enabled: false, auto_seed: false }, mcp: { auto_discover: false }, git_auto: { enabled: false },
    tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } }, usage: { aggregation: ['turn'], budget: {} }
  } }
  kernel = await createKernel({ cwd: root, configState, boot: false, trustState: { trusted: true }, handlers: { onEvent: event => events.push(event) } })
  cleanup.defer(() => kernel.shutdown())
  await kernel.sessions.touchSession({ sessionId, cwd: root, providerType: 'fixture', model: 'fixed-model', mode: 'agent' })
  const artifacts = createArtifactStore({ root: path.join(root, 'evidence') }), actor = { accountId: 'fixture', projectId: 'context', sessionId, runId: 'original-observed-run' }
  const originalEvidence = 'EXACT_ORIGINAL_TOOL_EVIDENCE\n' + 'old evidence '.repeat(2000)
  const artifact = await artifacts.put({ actor, content: originalEvidence, mime: 'text/plain', source: { kind: 'tool', operationId: 'original-tool' } })
  for (let index = 0; index < 12; index++) await kernel.sessions.appendMessage(sessionId, index % 2 ? 'assistant' : 'user', `Prior turn ${index}: ` + 'bounded historical note '.repeat(580), { turnId: `old-${index}`, ...(index === 0 ? { artifactRefs: [{ id: artifact.id, sha256: artifact.sha256, size: artifact.size }] } : {}) })
  if (opaqueHistory) await kernel.sessions.appendUserMessage(sessionId, [{ type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==' }], { turnId: 'opaque-history' })
  await kernel.sessions.appendAssistantMessage(sessionId, [{ type: 'tool_use', id: 'preserved-read', name: 'read', input: { path: 'original.txt' } }], { turnId: 'recent-tool' })
  await kernel.sessions.appendMessage(sessionId, 'user', [{ type: 'tool_result', tool_use_id: 'preserved-read', content: 'Original source is unchanged.' }], { turnId: 'recent-tool' })
  const before = (await kernel.sessions.getSession(sessionId)).messages
  const profiles = await prepareBudgetProfiles(configState)
  const withinBudget = operation => withRequestBudget({ budgetUsd: 10, deadlineAt: Date.now() + 60000, profiles }, operation)
  const execute = () => withinBudget(() => kernel.executeTurn({ sessionId, providerType: 'fixture', model: 'fixed-model', mode: 'agent', prompt: USER_CONSTRAINT, signal: controller.signal }))
  return { kernel, sessionId, requests, events, before, execute, withinBudget, configState, artifacts, actor, artifact, originalEvidence, controller }
}

test('strict context under 25 percent by ordinary estimate compacts within the frozen window and continues with exact retained evidence', async t => {
  const f = await fixture(t)
  const estimate = requestContextBudget({ messages: f.before, model: 'fixed-model', configState: f.configState })
  assert.ok(estimate.percent < 25)
  assert.ok(strictInputTokenBound({ messages: f.before }).tokens > LIMIT)
  const charged = await f.execute(), result = charged.result
  assert.match(result.reply, /CONTINUED_INSIDE_ORIGINAL_WINDOW/)
  assert.equal(f.requests.length, 2, 'exactly one bounded summary and one continued request, not a retry loop')
  assert.deepEqual(f.requests.map(request => request.summarizing), [true, false])
  for (const { body } of f.requests) {
    const bound = strictInputTokenBound({ system: body.messages[0].content, messages: body.messages.slice(1), tools: (body.tools || []).map(tool => ({ name: tool.function.name, description: tool.function.description, inputSchema: tool.function.parameters })) })
    assert.ok(bound.tokens + body.max_tokens <= LIMIT, `complete input/output ${bound.tokens}+${body.max_tokens} must fit the original ${LIMIT} window`)
  }
  const compacted = f.events.find(event => event.type === 'session.compacted')
  assert.ok(compacted.payload.beforeTokens > LIMIT)
  assert.ok(compacted.payload.afterTokens < compacted.payload.beforeTokens)
  const preflight = f.events.find(event => event.type === 'session.context.updated')?.payload.context
  assert.equal(preflight.source, 'strict-upper-bound'); assert.equal(preflight.estimated, true)
  assert.ok(preflight.requiredTokens <= LIMIT)
  const after = await f.kernel.sessions.getSession(f.sessionId), serialized = JSON.stringify(after.messages)
  assert.match(serialized, /NEW_USER_CONSTRAINT/)
  assert.match(serialized, /preserved-read/)
  assert.equal(after.messages.filter(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_use' && block.id === 'preserved-read')).length, 1)
  assert.equal(after.messages.filter(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result' && block.tool_use_id === 'preserved-read')).length, 1)
  assert.ok(after.messages[0].artifactRefs.some(ref => ref.id === f.artifact.id))
  const page = await f.artifacts.read({ actor: f.actor, id: f.artifact.id, limit: 256 * 1024 })
  assert.equal(Buffer.from(page.data, 'base64').toString(), f.originalEvidence)
  assert.equal(result.context.source, 'provider-usage', 'real model usage is not relabelled as the upper bound')
})

test('direct SDK compaction refuses a summary that cannot reserve output in the same window without losing history or retrying', async t => {
  const f = await fixture(t, { contextLimit: 65536, maxTokens: 60000 })
  const result = await f.withinBudget(() => f.kernel.sessions.compactSession({ sessionId: f.sessionId, model: 'fixed-model', providerType: 'fixture', configState: f.configState }))
  assert.equal(result.result.compacted, false)
  assert.match(result.result.reason, /输入加最大输出预留/)
  assert.equal(f.requests.length, 0)
  assert.deepEqual((await f.kernel.sessions.getSession(f.sessionId)).messages, f.before)
})

test('cancellation after summary HTTP dispatch preserves history and does not turn an unknown charge into zero', async t => {
  const f = await fixture(t, { abortSummary: true })
  const charged = await f.execute()
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].summarizing, true)
  assert.equal(charged.uncertain, true, 'the dispatched summary request remains conservatively charged')
  assert.ok(charged.costUsd > 0)
  assert.equal(f.events.some(event => event.type === 'session.compacted'), false)
  const after = await f.kernel.sessions.getSession(f.sessionId)
  assert.deepEqual(after.messages.slice(0, f.before.length), f.before)
  assert.match(JSON.stringify(after.messages), /NEW_USER_CONSTRAINT/)
})

test('an apparently shorter summary with a larger normalized strict input is never committed', async t => {
  const f = await fixture(t, { unicodeExpansion: true })
  const result = await f.withinBudget(() => f.kernel.sessions.compactSession({ sessionId: f.sessionId, model: 'fixed-model', providerType: 'fixture', configState: f.configState,
    requestContext: { system: 'Identical full continuation system.', tools: [{ name: 'read', description: 'Read evidence', inputSchema: { type: 'object' } }] } }))
  assert.equal(result.result.compacted, false)
  assert.equal(result.result.reasonCode, 'no_effective_strict_reduction')
  assert.ok(result.result.estimatedAfterTokens < result.result.estimatedBeforeTokens)
  assert.ok(result.result.strictAfterTokens >= result.result.strictBeforeTokens)
  assert.equal(f.requests.length, 1, 'one summary result, no recursive summary retry or main inference')
  assert.deepEqual((await f.kernel.sessions.getSession(f.sessionId)).messages, f.before)
})

test('strict compaction preserves opaque history when its route has no trustworthy complete media count', async t => {
  const f = await fixture(t, { opaqueHistory: true })
  const charged = await f.withinBudget(() => f.kernel.sessions.compactSession({ sessionId: f.sessionId, model: 'fixed-model', providerType: 'fixture', configState: f.configState }))
  assert.equal(charged.result.compacted, false)
  assert.equal(charged.result.reasonCode, 'strict_measurement_unavailable')
  assert.equal(f.requests.length, 1, 'the completed text-only summary cannot authorize a guessed media reduction')
  assert.deepEqual((await f.kernel.sessions.getSession(f.sessionId)).messages, f.before)
})

for (const failure of ['summaryFailure', 'concurrentAppend']) test(`strict compaction ${failure} preserves history and user constraints without a request loop`, async t => {
  const f = await fixture(t, { [failure]: true })
  const result = (await f.execute()).result
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].summarizing, true)
  assert.ok(result.error)
  const after = await f.kernel.sessions.getSession(f.sessionId)
  assert.deepEqual(after.messages.slice(0, f.before.length), f.before)
  assert.match(JSON.stringify(after.messages), /NEW_USER_CONSTRAINT/)
  if (failure === 'concurrentAppend') assert.match(JSON.stringify(after.messages), /CONCURRENT_USER_CONSTRAINT/)
})
