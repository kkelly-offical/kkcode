import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { openRunStore } from '../src/storage/run-store.mjs'
import { prepareBudgetProfile } from '../src/usage/budget-profiles.mjs'
import { budgetProfileId } from '../src/storage/run-budget-profile.mjs'
import { createLocalFreeInferenceAuthorization, localFreePolicy, isLocalFreeInferenceAuthorization } from '../src/usage/local-free.mjs'
import { withRequestBudget } from '../src/usage/request-budget.mjs'
import { requestProvider, requestProviderStream } from '../src/kernel/provider/router.mjs'

const opts = { skip: process.platform !== 'linux', timeout: 20000 }, key = 'synthetic-local-free-fixture-key'
const guard = run => ({ runId: run.id, expectedRevision: run.revision, ownerId: run.ownerId, ownerEpoch: run.ownerEpoch })
async function setup(t, { requestLimit = 2, tokenLimit = 50000, missingUsage = false, redirect = false, excessiveUsage = false, afterReserve = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-free-runtime-')), oldHome = process.env.KKCODE_HOME, oldKey = process.env.KKCODE_FREE_FIXTURE_KEY
  process.env.KKCODE_HOME = path.join(root, 'state'); process.env.KKCODE_FREE_FIXTURE_KEY = key
  const prices = path.join(root, 'prices.json'); await writeFile(prices, JSON.stringify({ models: { fixed: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } }))
  let calls = 0, redirected = 0
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    if (req.url === '/elsewhere') { redirected++; res.end('{}'); return }
    calls++; assert.equal(req.headers.authorization, `Bearer ${key}`)
    if (redirect) { res.writeHead(307, { Location: '/elsewhere' }); res.end(); return }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ model: 'fixed', choices: [{ message: { role: 'assistant', content: 'local answer' }, finish_reason: 'stop' }],
      ...(!missingUsage ? { usage: { prompt_tokens: excessiveUsage ? 999999 : 20, completion_tokens: 10 } } : {}) }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  const configState = { source: { userDir: root, userRaw: { usage: { pricing_file: prices } } }, config: { provider: { default: 'local', local: { type: 'openai', base_url: baseUrl, api_key_env: 'KKCODE_FREE_FIXTURE_KEY', default_model: 'fixed', context_limit: 8192, max_tokens: 32, stream: false } } } }
  const profile = await prepareBudgetProfile(configState, { providerType: 'local', model: 'fixed' })
  const create = overrides => createLocalFreeInferenceAuthorization({ profile, baseUrl, apiKeyEnv: 'KKCODE_FREE_FIXTURE_KEY', maxRequests: requestLimit, maxTokens: tokenLimit, authorize: async () => true, ...overrides })
  const authority = await create(), policy = localFreePolicy(authority), store = await openRunStore({ directory: path.join(root, 'runs') })
  const run = await store.createRun({ id: 'free-run', ownerId: 'fixture', contract: { objective: 'Local free fixture', requiredCriteria: [] } })
  await store.configureRunBudget({ ...guard(run), budgetUsd: 0, deadlineAt: Date.now() + 60000, profiles: [profile], localFreePolicy: policy, approval: { approved: true, actorId: 'fixture', reason: 'Explicit free-only local test' } })
  t.after(async () => { await store.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (oldHome === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = oldHome; if (oldKey === undefined) delete process.env.KKCODE_FREE_FIXTURE_KEY; else process.env.KKCODE_FREE_FIXTURE_KEY = oldKey; await rm(root, { recursive: true, force: true }) })
  const request = overrides => requestProvider({ configState, model: 'fixed', system: 'Local fixture only.', messages: [{ role: 'user', content: 'hello' }], tools: [], ...overrides })
  const scope = async (fn, token = authority) => {
    const budget = await store.getRunBudget({ runId: run.id })
    return withRequestBudget({ budgetUsd: 0, deadlineAt: budget.deadlineAt, profiles: [profile], localFreeAuthorization: token,
      localFreeUsage: { usedRequests: budget.usedRequests, reservedTokens: budget.reservedTokens }, durable: {
        reserve: async input => { const receipt = await store.reserveModelBudget({ ...guard(await store.getRun(run.id)), ...input, kind: 'model' }); await afterReserve?.(); return receipt },
        settle: async ({ requestId, amountUsd, status }) => store.settleModelBudget({ ...guard(await store.getRun(run.id)), requestId, amountUsd, status })
      } }, fn)
  }
  return { root, configState, profile, authority, policy, store, run, server, baseUrl, create, request, scope, calls: () => calls, redirected: () => redirected }
}

test('real branded loopback inference spends exactly USD0 with persisted finite quotas; ordinary zero budget remains denied', opts, async t => {
  const f = await setup(t)
  assert.equal(isLocalFreeInferenceAuthorization(f.authority), true); assert.equal(isLocalFreeInferenceAuthorization(structuredClone(f.authority)), false)
  assert.equal(JSON.stringify(f.policy).includes(key), false)
  await assert.rejects(f.request(), /plain HTTP/)
  await assert.rejects(withRequestBudget({ budgetUsd: 0, deadlineAt: Date.now() + 10000 }, f.request))
  assert.equal(f.calls(), 0)
  const first = await f.scope(f.request), second = await f.scope(f.request)
  assert.equal(first.costUsd, 0); assert.equal(second.costUsd, 0); assert.equal(first.uncertain, false)
  await assert.rejects(f.scope(f.request), { code: 'TASK_BUDGET_EXHAUSTED' })
  const budget = await f.store.getRunBudget({ runId: f.run.id })
  assert.equal(budget.budgetUsd, 0); assert.equal(budget.spentUsd, 0); assert.equal(budget.usedRequests, 2); assert.ok(budget.reservedTokens > 0)
  assert.ok(budget.requests.every(request => request.amountUsd === 0 && request.status === 'settled' && request.tokenAllowance > 0))
  assert.equal(f.calls(), 2)
})

test('unbranded, remote, DNS, nonzero prices, changed credentials/model and exhausted tokens never grant inference', opts, async t => {
  const f = await setup(t, { tokenLimit: 1 })
  await assert.rejects(f.scope(f.request, structuredClone(f.authority)), { code: 'LOCAL_FREE_AUTHORIZATION' })
  for (const baseUrl of ['https://example.invalid/v1', f.baseUrl.replace('127.0.0.1', 'localhost'), f.baseUrl + '?key=secret']) await assert.rejects(f.create({ baseUrl }), { code: 'LOCAL_FREE_AUTHORIZATION' })
  const priced = { ...f.profile, rates: { ...f.profile.rates, input: 1 } }; priced.id = budgetProfileId(priced)
  await assert.rejects(f.create({ profile: priced }), { code: 'LOCAL_FREE_AUTHORIZATION' })
  await assert.rejects(f.scope(f.request), { code: 'TASK_BUDGET_INSUFFICIENT' })
  await assert.rejects(f.scope(() => f.request({ model: 'other-model' })), { code: 'LOCAL_FREE_AUTHORIZATION' })
  process.env.KKCODE_FREE_FIXTURE_KEY = 'changed-key'
  await assert.rejects(f.scope(f.request), /plain HTTP/)
  assert.equal(f.calls(), 0)
})

test('zero-dollar unknown usage and redirects remain unresolved, never retried or redirected', opts, async t => {
  const f = await setup(t, { missingUsage: true })
  const result = await f.scope(f.request)
  assert.equal(result.uncertain, true); assert.equal(result.costUsd, 0)
  assert.equal((await f.store.getRunBudget({ runId: f.run.id })).requests[0].status, 'unknown')
  await assert.rejects(f.scope(f.request))
  assert.equal(f.calls(), 1)
})

test('approved local credentials never follow HTTP redirect even to another local path', opts, async t => {
  const f = await setup(t, { redirect: true })
  await assert.rejects(f.scope(f.request))
  assert.equal(f.calls(), 1); assert.equal(f.redirected(), 0)
})

test('an upstream reporting token use beyond the preflight allowance stops even when USD cost is zero', opts, async t => {
  const f = await setup(t, { excessiveUsage: true })
  await assert.rejects(f.scope(f.request), error => error.code === 'LOCAL_FREE_TOKEN_OUTCOME' && error.operationNotStarted === false)
  const budget = await f.store.getRunBudget({ runId: f.run.id })
  assert.equal(budget.requests[0].status, 'unknown'); assert.equal(budget.requests[0].reservedUsd, 0)
  await assert.rejects(f.scope(f.request))
  assert.equal(f.calls(), 1)
})

test('replacing the listener invalidates a prior real authorization before HTTP', opts, async t => {
  const f = await setup(t), port = f.server.address().port
  f.server.closeAllConnections(); await new Promise(resolve => f.server.close(resolve))
  const replacement = createServer((_req, res) => { res.end('{}') })
  replacement.listen(port, '127.0.0.1'); await once(replacement, 'listening')
  t.after(async () => { replacement.closeAllConnections(); await new Promise(resolve => replacement.close(resolve)) })
  await assert.rejects(f.scope(f.request), { code: 'LOCAL_FREE_AUTHORIZATION' })
  await assert.rejects(f.create({ expectedPolicy: f.policy }), { code: 'LOCAL_FREE_AUTHORIZATION' })
  assert.equal(f.calls(), 0)
})

for (const stream of [false, true]) test(`listener replacement while awaiting durable reservation cannot receive the authorized credential (stream=${stream})`, opts, async t => {
  let replaceListener
  const f = await setup(t, { afterReserve: () => replaceListener() }), port = f.server.address().port
  let replacements = 0, leakedCredentials = 0
  const replacement = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain synthetic request only */ }
    replacements++; if (request.headers.authorization === `Bearer ${key}`) leakedCredentials++
    response.setHeader('Content-Type', stream ? 'text/event-stream' : 'application/json')
    const body = JSON.stringify({ model: 'fixed', choices: [{ [stream ? 'delta' : 'message']: { role: 'assistant', content: 'unapproved listener' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 1 } })
    response.end(stream ? `data: ${body}\n\ndata: [DONE]\n\n` : body)
  })
  t.after(async () => { replacement.closeAllConnections(); if (replacement.listening) await new Promise(resolve => replacement.close(resolve)) })
  replaceListener = async () => {
    f.server.closeAllConnections(); await new Promise(resolve => f.server.close(resolve))
    replacement.listen(port, '127.0.0.1'); await once(replacement, 'listening')
  }
  let failure
  try { await f.scope(stream ? async () => { for await (const _chunk of requestProviderStream({ configState: f.configState, model: 'fixed', system: 'Synthetic listener identity test.', messages: [{ role: 'user', content: 'hello' }], tools: [] })) { /* drain */ } } : f.request) }
  catch (error) { failure = error }
  t.diagnostic(JSON.stringify({ replacements, leakedCredentials, errorCode: failure?.code || null }))
  assert.equal(failure?.code, 'LOCAL_FREE_AUTHORIZATION')
  assert.equal(replacements, 0); assert.equal(leakedCredentials, 0)
  const budget = await f.store.getRunBudget({ runId: f.run.id })
  assert.equal(budget.requests.length, 1)
  assert.equal(budget.requests[0].status, 'settled', 'known pre-dispatch denial must not leave a false unknown outcome')
  assert.equal(budget.requests[0].amountUsd, 0)
})

for (const stream of [false, true]) test(`strict local-free provider never retries a 503 against a replacement listener (stream=${stream})`, opts, async t => {
  const f = await setup(t), port = f.server.address().port
  let initialRequests = 0, replacementRequests = 0, leakedCredentials = 0, resolveSwap, rejectSwap
  const swapped = new Promise((resolve, reject) => { resolveSwap = resolve; rejectSwap = reject })
  const replacement = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain synthetic request only */ }
    replacementRequests++; if (request.headers.authorization === `Bearer ${key}`) leakedCredentials++
    response.writeHead(503); response.end('{}')
  })
  t.after(async () => { replacement.closeAllConnections(); if (replacement.listening) await new Promise(resolve => replacement.close(resolve)) })
  f.server.removeAllListeners('request')
  f.server.on('request', async (request, response) => {
    for await (const _chunk of request) { /* drain synthetic request only */ }
    initialRequests++; assert.equal(request.headers.authorization, `Bearer ${key}`)
    response.once('finish', () => {
      f.server.closeAllConnections()
      f.server.close(() => { replacement.once('error', rejectSwap); replacement.listen(port, '127.0.0.1', resolveSwap) })
    })
    response.writeHead(503, { 'Content-Type': 'application/json' }); response.end('{}')
  })
  const invoke = stream ? async () => { for await (const _chunk of requestProviderStream({ configState: f.configState, model: 'fixed', messages: [{ role: 'user', content: 'hello' }], tools: [] })) { /* drain */ } } : f.request
  await assert.rejects(f.scope(invoke))
  await swapped
  assert.equal(initialRequests, 1); assert.equal(replacementRequests, 0); assert.equal(leakedCredentials, 0)
  const budget = await f.store.getRunBudget({ runId: f.run.id })
  assert.equal(budget.usedRequests, 1); assert.equal(budget.requests[0].status, 'unknown')
})
