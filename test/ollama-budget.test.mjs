import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { prepareBudgetProfiles, budgetRoute } from '../src/usage/budget-profiles.mjs'
import { withRequestBudget } from '../src/usage/request-budget.mjs'
import { createLocalFreeInferenceAuthorization, localFreePolicy } from '../src/usage/local-free.mjs'
import { requestProvider, requestProviderStream } from '../src/kernel/provider/router.mjs'
import { openRunStore } from '../src/storage/run-store.mjs'

const guard = run => ({ runId: run.id, expectedRevision: run.revision, ownerId: run.ownerId, ownerEpoch: run.ownerEpoch })
async function setup(t, { free = false, stream = false, partial = false, authenticated = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-ollama-budget-')), previous = process.env.KKCODE_HOME
  const oldKey = process.env.KKCODE_OLLAMA_FIXTURE_KEY, fixtureKey = 'synthetic-authenticated-ollama-only'
  process.env.KKCODE_HOME = path.join(root, 'state')
  if (authenticated) process.env.KKCODE_OLLAMA_FIXTURE_KEY = fixtureKey
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ path: req.url, body, authenticated: req.headers.authorization === `Bearer ${fixtureKey}` })
    if (authenticated && req.headers.authorization !== `Bearer ${fixtureKey}`) { res.writeHead(401); res.end('{}'); return }
    const output = { model: 'llama-fixture', message: { role: 'assistant', content: 'Native Ollama fixture reply.' }, done: true, done_reason: 'stop', prompt_eval_count: 10, ...(!partial ? { eval_count: 2 } : {}) }
    res.setHeader('Content-Type', stream ? 'application/x-ndjson' : 'application/json')
    res.end(JSON.stringify(output) + (stream ? '\n' : ''))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const prices = path.join(root, 'prices.json')
  await writeFile(prices, JSON.stringify({ per_tokens: 1, models: { 'llama-fixture': { input: free ? 0 : 1, output: free ? 0 : 2, cache_read: free ? 0 : 1, cache_write: free ? 0 : 1 } } }))
  const configState = { source: { userDir: root, userRaw: { usage: { pricing_file: prices } } }, config: { provider: { default: 'local', local: {
    type: 'ollama', base_url: `http://127.0.0.1:${server.address().port}/proxy`, endpoints: { ollama: 'engine' }, api_key_env: authenticated ? 'KKCODE_OLLAMA_FIXTURE_KEY' : '', default_model: 'local/llama-fixture', context_limit: 8192, max_tokens: 32, stream
  } } } }
  const profiles = await prepareBudgetProfiles(configState)
  assert.equal(profiles.length, 1); assert.equal(profiles[0].protocol, 'ollama'); assert.equal(profiles[0].model, 'llama-fixture')
  const route = budgetRoute(configState, { providerType: 'local' })
  let authority
  if (free) authority = await createLocalFreeInferenceAuthorization({ profile: profiles[0], baseUrl: route.baseUrl, apiKeyEnv: authenticated ? 'KKCODE_OLLAMA_FIXTURE_KEY' : '', maxRequests: 2, maxTokens: 100000, authorize: () => true })
  const store = await openRunStore({ directory: path.join(root, 'runs') })
  const run = await store.createRun({ id: 'ollama-budget', ownerId: 'fixture', initialState: 'running', contract: { objective: 'Exercise native Ollama with exact route', requiredCriteria: [] } })
  await store.configureRunBudget({ ...guard(run), budgetUsd: free ? 0 : 20000, deadlineAt: Date.now() + 60000, profiles, ...(free ? { localFreePolicy: localFreePolicy(authority) } : {}), approval: { approved: true, actorId: 'fixture', reason: 'Synthetic model only' } })
  t.after(async () => { await store.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; if (oldKey === undefined) delete process.env.KKCODE_OLLAMA_FIXTURE_KEY; else process.env.KKCODE_OLLAMA_FIXTURE_KEY = oldKey; await rm(root, { recursive: true, force: true }) })
  const request = async (extra = {}) => {
    const input = { configState, providerType: 'local', model: 'local/llama-fixture', system: 'Budget fixture.', messages: [{ role: 'user', content: 'hello' }], tools: [], ...extra }
    if (!stream) return requestProvider(input)
    const chunks = []; for await (const chunk of requestProviderStream(input)) chunks.push(chunk)
    return chunks
  }
  const scoped = async action => {
    const budget = await store.getRunBudget({ runId: run.id })
    return withRequestBudget({ budgetUsd: budget.budgetUsd, deadlineAt: budget.deadlineAt, profiles,
      ...(free ? { localFreeAuthorization: authority, localFreeUsage: { usedRequests: budget.usedRequests, reservedTokens: budget.reservedTokens } } : {}),
      durable: { reserve: async input => store.reserveModelBudget({ ...guard(await store.getRun(run.id)), ...input, kind: 'model' }),
        settle: async ({ requestId, amountUsd, status }) => store.settleModelBudget({ ...guard(await store.getRun(run.id)), requestId, amountUsd, status }) } }, action)
  }
  return { configState, profiles, route, request, scoped, requests, store, run }
}

for (const free of [false, true]) for (const stream of [false, true]) test(`real native Ollama budget uses inference routing and output cap (free=${free}, NDJSON=${stream})`, { skip: free && process.platform !== 'linux' }, async t => {
  const f = await setup(t, { free, stream }), result = await f.scoped(f.request)
  assert.equal(result.uncertain, false); assert.equal(result.costUsd, free ? 0 : 14)
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].path, '/proxy/engine/api/chat')
  assert.equal(f.requests[0].body.model, 'llama-fixture'); assert.equal(f.requests[0].body.options.num_predict, 32)
  assert.equal(f.requests[0].body.stream, stream)
  const budget = await f.store.getRunBudget({ runId: f.run.id })
  assert.equal(budget.requests[0].profileId, f.profiles[0].id); assert.equal(budget.requests[0].status, 'settled')
})

for (const stream of [false, true]) test(`native Ollama partial usage remains unknown and cannot mint free zero counters (NDJSON=${stream})`, { skip: process.platform !== 'linux' }, async t => {
  const f = await setup(t, { free: true, stream, partial: true }), result = await f.scoped(f.request)
  assert.equal(result.uncertain, true)
  assert.equal((await f.store.getRunBudget({ runId: f.run.id })).requests[0].status, 'unknown')
  await assert.rejects(f.scoped(f.request))
  assert.equal(f.requests.length, 1)
})

for (const stream of [false, true]) test(`explicitly authorized authenticated Ollama forwards the exact scoped Bearer credential (NDJSON=${stream})`, { skip: process.platform !== 'linux' }, async t => {
  const f = await setup(t, { free: true, stream, authenticated: true })
  const result = await f.scoped(f.request)
  assert.equal(result.uncertain, false); assert.equal(result.costUsd, 0)
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].authenticated, true)
  assert.equal((await f.store.getRunBudget({ runId: f.run.id })).requests[0].status, 'settled')
})

test('native Ollama strict opaque input and ordinary HTTP credentials remain denied before dispatch', async t => {
  const f = await setup(t)
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  await assert.rejects(f.scoped(() => f.request({ messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: png }] }] })), { code: 'BUDGET_INPUT_UNBOUNDED' })
  f.configState.config.provider.local.api_key = 'synthetic-secret'
  await assert.rejects(f.request(), /plain HTTP/)
  assert.equal(f.requests.length, 0)
})
