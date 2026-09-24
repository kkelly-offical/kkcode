import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { strictInputTokenBound } from '../src/usage/input-token-bound.mjs'
import { withRequestBudget } from '../src/usage/request-budget.mjs'
import { prepareBudgetProfiles } from '../src/usage/budget-profiles.mjs'
import { requestProvider, countTokensProvider } from '../src/kernel/provider/router.mjs'
import { attachResponsesState } from '../src/kernel/provider/responses-state.mjs'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const tool = { name: 'read', description: 'Read a bounded file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }

async function fixture(t, { protocol = 'responses', countStatus = 200, countObject = 'response.input_tokens', onCount = null, hangCount = false, redirectCount = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-input-bound-')), old = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  const prices = path.join(root, 'prices.json')
  await writeFile(prices, JSON.stringify({ per_tokens: 1, models: { fixedmodel: { input: 1, output: 2, cache_read: 1, cache_write: 1 } } }))
  const requests = [], counts = [], countHeaders = [], countUrls = [], redirected = []
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    if (req.url.startsWith('/redirect')) { redirected.push(body); res.end('{}'); return }
    if (req.url.startsWith('/v1/responses/input_tokens')) {
      counts.push(body); countHeaders.push(req.headers); countUrls.push(req.url)
      onCount?.(body)
      if (hangCount) return
      if (redirectCount) { res.writeHead(307, { Location: '/redirect' }); res.end(); return }
      res.writeHead(countStatus, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: countObject, input_tokens: 123 })); return
    }
    requests.push(body); res.setHeader('Content-Type', 'application/json')
    if (protocol === 'responses') res.end(JSON.stringify({ id: 'response-fixed', model: 'fixedmodel', service_tier: 'default', status: 'completed',
      output: [{ type: 'reasoning', id: 'reasoning-fixed', encrypted_content: 'fixed-opaque-state', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reviewed screenshot.' }] }], usage: { input_tokens: 123, output_tokens: 2 } }))
    else res.end(JSON.stringify({ model: 'fixedmodel', choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2 } }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const configState = { source: { userDir: root, userRaw: { usage: { pricing_file: prices } } }, config: {
    provider: { default: 'fixture', fixture: { type: protocol === 'responses' ? 'openai-responses' : 'openai', base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key: '', api_key_env: '', default_model: 'fixedmodel', context_limit: 8192, max_tokens: 20, stream: false, timeout_ms: 1000, model_capabilities: { fixedmodel: { image: true, tool_call: true } } } } } }
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (old === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = old; await rm(root, { recursive: true, force: true }) })
  const request = (options = {}) => requestProvider({ configState, model: 'fixedmodel', system: 'Inspect the supplied input.', messages: [{ role: 'user', content: 'hello' }], tools: [tool], ...options })
  return { configState, request, requests, counts, countHeaders, countUrls, redirected }
}

test('serialized input bound includes system, tool schemas, Unicode expansion and tool result text', () => {
  const small = { system: '', messages: [{ role: 'user', content: 'hello' }], tools: [] }
  const unicode = strictInputTokenBound({ ...small, messages: [{ role: 'user', content: 'ﷺ'.repeat(10000) }] })
  assert.ok(unicode.bytes > unicode.rawBytes * 8, 'NFKC expansion cannot be missed by raw bytes × 2')
  assert.ok(unicode.tokens >= unicode.bytes * 2)
  const full = strictInputTokenBound({ system: 's'.repeat(20000), messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 't'.repeat(20000) }] }], tools: [{ ...tool, description: 'd'.repeat(20000) }] })
  assert.ok(full.tokens > 120000)
  assert.throws(() => strictInputTokenBound({ ...small, messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: PNG }] }] }), { code: 'BUDGET_INPUT_UNBOUNDED' })
  assert.throws(() => strictInputTokenBound({ ...small, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://fixture.invalid/changing.png' } }] }] }, { trustedCount: 1 }), /可变远程附件/)
})

test('a tiny client context limit cannot make a large actual request pass its old low reservation', async t => {
  const f = await fixture(t, { protocol: 'openai' })
  f.configState.config.provider.fixture.context_limit = 100
  await assert.rejects(withRequestBudget({ budgetUsd: 1000, deadlineAt: Date.now() + 60000 }, () => f.request({ system: 'ﷺ'.repeat(1000), tools: [{ ...tool, description: 'large-schema-description'.repeat(1000) }] })), { code: 'BUDGET_INPUT_WINDOW' })
  assert.equal(f.requests.length, 0)
})

test('crossing a frozen long-context pricing window is denied before reservation and HTTP even with ample funds', async t => {
  const f = await fixture(t, { protocol: 'openai' }), profiles = await prepareBudgetProfiles(f.configState)
  let reservations = 0
  await assert.rejects(withRequestBudget({ budgetUsd: 1000000, deadlineAt: Date.now() + 60000, profiles,
    durable: { reserve: async () => { reservations++; return { fresh: true } }, settle: async () => {} } }, () => f.request({ system: 'Outside the approved rate window. '.repeat(1000) })),
  error => error.code === 'BUDGET_INPUT_WINDOW' && error.operationNotStarted === true && error.needsCompaction === true && /核价/.test(error.message))
  assert.equal(reservations, 0); assert.equal(f.requests.length, 0)
})

test('count preflight reports the dispatch upper bound only for strict scope, including adapters without countTokens', async t => {
  const f = await fixture(t, { protocol: 'openai' }), reports = []
  const input = { configState: f.configState, providerType: 'fixture', model: 'fixedmodel', system: 'Full schema and prompt boundary.', messages: [{ role: 'user', content: 'large context '.repeat(1000) }], tools: [tool], onInputBound: report => reports.push(report) }
  assert.equal(await countTokensProvider(input), null)
  assert.equal(reports.length, 0, 'ordinary conversation keeps its existing inexpensive estimate')
  for (const protocol of ['openai', 'ollama']) {
    f.configState.config.provider.fixture.type = protocol
    await withRequestBudget({ budgetUsd: 1000000, deadlineAt: Date.now() + 60000 }, async () => {
      assert.equal(await countTokensProvider(input), null, 'public number/null count API is unchanged')
    })
    const report = reports.at(-1)
    assert.equal(report.source, 'strict-upper-bound')
    assert.equal(report.tokens, strictInputTokenBound(input).tokens)
    assert.ok(report.tokens > f.configState.config.provider.fixture.context_limit)
  }
  assert.equal(reports.length, 2)
  assert.equal(f.requests.length, 0)
  assert.equal(f.counts.length, 0)
})

for (const frozen of [false, true]) test(`direct provider requests include maximum output in the current and approved context window (frozen=${frozen})`, async t => {
  const f = await fixture(t, { protocol: 'openai' }), system = 'X'.repeat(700), messages = [{ role: 'user', content: 'hello' }]
  f.configState.config.provider.fixture.max_tokens = 4096
  const bound = strictInputTokenBound({ system, messages, tools: [tool] }).tokens
  assert.ok(bound < 8192 && bound + 4096 > 8192)
  const profiles = frozen ? await prepareBudgetProfiles(f.configState) : []
  const withinBudget = operation => withRequestBudget({ budgetUsd: 1000000, deadlineAt: Date.now() + 60000, profiles }, operation)
  await assert.rejects(withinBudget(() => f.request({ system, messages })), error => error.code === 'BUDGET_INPUT_WINDOW' && error.needsCompaction === true && error.operationNotStarted === true)
  assert.equal(f.requests.length, 0)
  const fittingOutput = 8192 - bound
  await withinBudget(() => f.request({ system, messages, maxTokens: fittingOutput }))
  assert.equal(f.requests.length, 1, 'the exact input/output boundary remains usable')
  assert.equal(f.requests[0].max_tokens, fittingOutput)
  f.configState.config.provider.fixture.context_limit = 8191
  await assert.rejects(withinBudget(() => f.request({ system, messages, maxTokens: fittingOutput })), { code: 'BUDGET_INPUT_WINDOW' })
  assert.equal(f.requests.length, 1, 'a larger frozen profile cannot override the current narrower window')
})

test('official Responses processed count takes precedence over conservative text bytes at the approved window', async t => {
  const f = await fixture(t), messages = [{ role: 'user', content: 'A compressible synthetic input. '.repeat(1000) }]
  assert.ok(strictInputTokenBound({ messages, tools: [tool] }).tokens > 8192)
  const result = await withRequestBudget({ budgetUsd: 100000, deadlineAt: Date.now() + 60000 }, () => f.request({ messages }))
  assert.equal(f.counts.length, 1); assert.equal(f.requests.length, 1); assert.equal(result.costUsd, 127); assert.equal(result.uncertain, false)
})

test('mutable remote media is rejected before count, while fixed inline screenshot counting remains supported', async t => {
  const f = await fixture(t)
  await assert.rejects(withRequestBudget({ budgetUsd: 100000, deadlineAt: Date.now() + 60000 }, () => f.request({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'https://example.invalid/changing.png' }] }] })), { code: 'BUDGET_INPUT_UNBOUNDED' })
  assert.equal(f.counts.length, 0); assert.equal(f.requests.length, 0)
})

test('real Responses count and inference share the same image/schema/native payload across rounds', async t => {
  const f = await fixture(t)
  const initial = [{ role: 'user', content: [{ type: 'text', text: 'Review a captured page.' }, { type: 'image', mediaType: 'image/png', data: PNG }] }]
  const result = await withRequestBudget({ budgetUsd: 100000, deadlineAt: Date.now() + 60000 }, async () => {
    const first = await f.request({ messages: initial })
    const content = attachResponsesState([{ type: 'text', text: first.text }], first.providerState)
    return f.request({ messages: [...initial, { role: 'assistant', content }, { role: 'user', content: 'Continue from that screenshot.' }] })
  })
  assert.equal(result.uncertain, false); assert.equal(result.costUsd, 254)
  assert.equal(f.counts.length, 2); assert.equal(f.requests.length, 2)
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(f.counts[i].input, f.requests[i].input)
    assert.deepEqual(f.counts[i].tools, f.requests[i].tools)
    assert.equal(f.counts[i].instructions, f.requests[i].instructions)
    for (const key of ['max_output_tokens', 'stream', 'store', 'service_tier', 'temperature', 'include']) assert.equal(key in f.counts[i], false)
    assert.equal(f.counts[i].model, 'fixedmodel')
    assert.match(f.countHeaders[i]['user-agent'], /^KK[ -]Code/)
  }
  assert.ok(f.counts[0].input[0].content.some(block => block.type === 'input_image' && block.image_url.startsWith('data:image/png;base64,')))
  assert.ok(f.counts[1].input.some(item => item.encrypted_content === 'fixed-opaque-state'))
})

test('caller mutation during real token counting cannot change the dispatched snapshot', async t => {
  const messages = [{ role: 'user', content: 'original prompt' }], tools = [structuredClone(tool)]
  const f = await fixture(t, { onCount: () => { messages[0].content = 'changed'.repeat(10000); tools[0].description = 'changed'.repeat(10000) } })
  await withRequestBudget({ budgetUsd: 100000, deadlineAt: Date.now() + 60000 }, () => f.request({ messages, tools }))
  assert.equal(f.requests[0].input[0].content, 'original prompt')
  assert.equal(f.requests[0].tools[0].description, tool.description)
  assert.deepEqual(f.counts[0].input, f.requests[0].input)
})

test('missing count endpoint only permits bounded text, never silently estimates image cost', async t => {
  const f = await fixture(t, { countStatus: 404 })
  await withRequestBudget({ budgetUsd: 100000, deadlineAt: Date.now() + 60000 }, () => f.request())
  await assert.rejects(withRequestBudget({ budgetUsd: 100000, deadlineAt: Date.now() + 60000 }, () => f.request({ messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: PNG }] }] })), { code: 'BUDGET_INPUT_UNBOUNDED' })
  assert.equal(f.requests.length, 1)
})

test('ordinary Responses conversations do not acquire a new remote count dependency', async t => {
  const f = await fixture(t, { countStatus: 404 })
  await f.request()
  assert.equal(await countTokensProvider({ configState: f.configState, model: 'fixedmodel', system: '', messages: [], tools: [] }), null)
  assert.equal(f.counts.length, 0); assert.equal(f.requests.length, 1)
  assert.equal(await countTokensProvider({ configState: f.configState, model: 'fixedmodel', system: '', messages: [], tools: [], allowRemote: true }), null)
  assert.equal(f.counts.length, 1)
})

for (const mode of ['redirect', 'wrong-object', 'timeout', 'cancel']) test(`count-only ${mode} cannot dispatch inference or follow an unguarded URL`, async t => {
  const f = await fixture(t, { redirectCount: mode === 'redirect', countObject: mode === 'wrong-object' ? 'response' : 'response.input_tokens', hangCount: ['timeout', 'cancel'].includes(mode) })
  f.configState.config.provider.fixture.timeout_ms = 30
  const controller = new AbortController()
  if (mode === 'cancel') setTimeout(() => controller.abort(), 10)
  await assert.rejects(withRequestBudget({ budgetUsd: 100000, deadlineAt: Date.now() + 60000 }, () => f.request({ signal: controller.signal })))
  assert.equal(f.requests.length, 0); assert.equal(f.redirected.length, 0)
})

test('data policy applies before the real count-only connection', async t => {
  const f = await fixture(t)
  f.configState.config.data_policy = { models: { providers: [] } }
  await assert.rejects(withRequestBudget({ budgetUsd: 100000, deadlineAt: Date.now() + 60000 }, f.request))
  assert.equal(f.counts.length, 0); assert.equal(f.requests.length, 0)
})

test('closed, expired and zero strict budgets cannot even send a count-only request', async t => {
  const f = await fixture(t)
  await assert.rejects(withRequestBudget({ budgetUsd: 0, deadlineAt: Date.now() + 60000 }, f.request), { code: 'TASK_BUDGET_EXHAUSTED' })
  await assert.rejects(withRequestBudget({ budgetUsd: 100000, deadlineAt: 1 }, f.request), { code: 'TASK_DEADLINE' })
  let release, late
  const gate = new Promise(resolve => { release = resolve })
  await withRequestBudget({ budgetUsd: 100000, deadlineAt: Date.now() + 60000 }, async () => { late = gate.then(f.request); return 'scope closed' })
  release()
  await assert.rejects(late, { code: 'TASK_DEADLINE' })
  assert.equal(f.counts.length, 0); assert.equal(f.requests.length, 0)
})
