import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { withRequestBudget } from '../src/usage/request-budget.mjs'
import { requestProvider, requestProviderStream } from '../src/kernel/provider/router.mjs'
import { prepareBudgetProfiles } from '../src/usage/budget-profiles.mjs'
const RESERVATION = 8192 + 20, ALLOW_ONE = RESERVATION + 10

async function setup(t, { stream = false, missing = false, fail = false, partial = null, responseModel = 'budgetmodel', tier = undefined, lateIdentity = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-request-budget-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  const file = path.join(root, 'prices.json')
  await writeFile(file, JSON.stringify({ per_tokens: 1, models: { budgetmodel: { input: 1, output: 2, cache_read: 1, cache_write: 1 } } }))
  let calls = 0
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    calls++
    if (fail) { response.writeHead(503); response.end('fixture unavailable'); return }
    const usage = partial === 'input' ? { prompt_tokens: 10 } : partial === 'output' ? { completion_tokens: 2 } : { prompt_tokens: 10, completion_tokens: 2 }
    const identity = { ...(responseModel !== null ? { model: responseModel } : {}), ...(tier !== undefined ? { service_tier: tier } : {}) }
    if (stream) {
      response.setHeader('Content-Type', 'text/event-stream')
      response.write(`data: ${JSON.stringify({ ...identity, choices: [{ index: 0, delta: { content: 'bounded reply' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...identity, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...(!missing ? { usage } : {}) })}\n\n`)
      if (lateIdentity) response.write(`data: ${JSON.stringify({ ...lateIdentity, choices: [] })}\n\n`)
      response.end('data: [DONE]\n\n'); return
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ ...identity, choices: [{ index: 0, message: { role: 'assistant', content: 'bounded reply' }, finish_reason: 'stop' }], ...(!missing ? { usage } : {}) }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const configState = { source: { userDir: root, userRaw: { usage: { pricing_file: file } } }, config: { provider: { default: 'fixture', fixture: { type: 'openai', base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key: '', api_key_env: '', default_model: 'budgetmodel', context_limit: 8192, max_tokens: 10, retry_attempts: 5, retry_base_delay_ms: 1, stream } } } }
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  const request = () => requestProvider({ configState, providerType: 'fixture', model: 'budgetmodel', system: 'Fixture.', messages: [{ role: 'user', content: 'hello' }], tools: [] })
  return { configState, request, calls: () => calls }
}

test('strict request budget refuses insufficient worst-case allowance before real HTTP and settles actual price', async t => {
  const f = await setup(t), deadlineAt = Date.now() + 60000
  await assert.rejects(withRequestBudget({ budgetUsd: RESERVATION - 1, deadlineAt }, f.request), { code: 'TASK_BUDGET_INSUFFICIENT' })
  assert.equal(f.calls(), 0)
  const result = await withRequestBudget({ budgetUsd: ALLOW_ONE, deadlineAt }, async () => { await f.request(); await assert.rejects(f.request(), { code: 'TASK_BUDGET_INSUFFICIENT' }); return 'done' })
  assert.equal(result.costUsd, 14); assert.equal(result.uncertain, false); assert.equal(f.calls(), 1)
})

test('parallel requests reserve atomically, while expired/unknown-price contexts do not send requests', async t => {
  const f = await setup(t), deadlineAt = Date.now() + 60000
  const result = await withRequestBudget({ budgetUsd: ALLOW_ONE, deadlineAt }, async () => Promise.allSettled([f.request(), f.request()]))
  assert.equal(result.result.filter(item => item.status === 'fulfilled').length, 1); assert.equal(f.calls(), 1)
  await assert.rejects(withRequestBudget({ budgetUsd: ALLOW_ONE, deadlineAt: 1 }, f.request), { code: 'TASK_DEADLINE' })
  f.configState.config.provider.fixture.context_limit = 0
  await assert.rejects(withRequestBudget({ budgetUsd: ALLOW_ONE, deadlineAt }, f.request), { code: 'TASK_BUDGET_CONTEXT_UNKNOWN' })
  assert.equal(f.calls(), 1)
})

test('strict request failures do not trigger five paid replays and retain unknown reservation', async t => {
  const f = await setup(t, { fail: true })
  const result = await withRequestBudget({ budgetUsd: ALLOW_ONE, deadlineAt: Date.now() + 60000 }, async () => {
    await assert.rejects(f.request())
    await assert.rejects(f.request(), { code: 'TASK_BUDGET_EXHAUSTED' })
  })
  assert.equal(f.calls(), 1); assert.equal(result.uncertain, true); assert.equal(result.costUsd, RESERVATION)
})

test('streaming budget settles cumulative final usage once, not every frame', async t => {
  const f = await setup(t, { stream: true })
  const result = await withRequestBudget({ budgetUsd: ALLOW_ONE, deadlineAt: Date.now() + 60000 }, async () => {
    const chunks = []
    for await (const chunk of requestProviderStream({ configState: f.configState, model: 'budgetmodel', system: 'Fixture.', messages: [{ role: 'user', content: 'hello' }], tools: [] })) chunks.push(chunk)
    return chunks
  })
  assert.equal(f.calls(), 1); assert.equal(result.costUsd, 14); assert.equal(result.uncertain, false)
})

test('an answer without provider usage is not silently billed as zero', async t => {
  const f = await setup(t, { missing: true })
  const result = await withRequestBudget({ budgetUsd: ALLOW_ONE, deadlineAt: Date.now() + 60000 }, f.request)
  assert.equal(f.calls(), 1); assert.equal(result.costUsd, RESERVATION); assert.equal(result.uncertain, true)
})

test('cancellation during durable reservation settles proven un-dispatched inference as zero, not unknown', async t => {
  const f = await setup(t), controller = new AbortController(), receipts = []
  const result = await withRequestBudget({ budgetUsd: ALLOW_ONE, deadlineAt: Date.now() + 60000, profiles: await prepareBudgetProfiles(f.configState), durable: {
    reserve: async () => { controller.abort(); return { fresh: true } },
    settle: async value => { receipts.push(value) }
  } }, async () => {
    await assert.rejects(requestProvider({ configState: f.configState, model: 'budgetmodel', system: 'Fixture.', messages: [{ role: 'user', content: 'hello' }], tools: [], signal: controller.signal }))
  })
  assert.equal(f.calls(), 0); assert.equal(receipts.length, 1); assert.equal(receipts[0].amountUsd, 0); assert.equal(receipts[0].status, 'settled')
  assert.equal(result.costUsd, 0); assert.equal(result.uncertain, false)
})

test('incomplete custom price files do not turn fallback cache rates into a strict billing guarantee', async t => {
  const f = await setup(t)
  await writeFile(f.configState.source.userRaw.usage.pricing_file, JSON.stringify({ per_tokens: 1, models: { budgetmodel: { input: 1, output: 2 } } }))
  await assert.rejects(withRequestBudget({ budgetUsd: 1000, deadlineAt: Date.now() + 60000 }, f.request), { code: 'TASK_BUDGET_PRICE_UNKNOWN' })
  assert.equal(f.calls(), 0)
})

test('ordinary price prefix matching is not an approved strict model price', async t => {
  const f = await setup(t)
  await writeFile(f.configState.source.userRaw.usage.pricing_file, JSON.stringify({ per_tokens: 1, models: { budget: { input: 1, output: 2, cache_read: 1, cache_write: 1 } } }))
  await assert.rejects(withRequestBudget({ budgetUsd: 100000, deadlineAt: Date.now() + 60000 }, f.request), { code: 'TASK_BUDGET_PRICE_UNKNOWN' })
  await assert.rejects(prepareBudgetProfiles(f.configState), { code: 'BUDGET_PROFILE_REQUIRED' })
  assert.equal(f.calls(), 0)
})

for (const stream of [false, true]) for (const partial of ['input', 'output']) test(`partial raw ${partial}-only usage cannot mint zero-filled billing proof (stream=${stream})`, async t => {
  const f = await setup(t, { stream, partial })
  const request = async () => {
    if (!stream) return f.request()
    for await (const _chunk of requestProviderStream({ configState: f.configState, model: 'budgetmodel', system: 'Fixture.', messages: [{ role: 'user', content: 'hello' }], tools: [] })) { /* consume */ }
  }
  const result = await withRequestBudget({ budgetUsd: ALLOW_ONE, deadlineAt: Date.now() + 60000 }, async () => {
    await request(); await assert.rejects(request(), { code: 'TASK_BUDGET_EXHAUSTED' })
  })
  assert.equal(f.calls(), 1); assert.equal(result.costUsd, RESERVATION); assert.equal(result.uncertain, true)
})

for (const stream of [false, true]) for (const mismatch of [{ responseModel: null }, { responseModel: 'budgetmodel-2026-09-24' }, { tier: 'priority' }]) test(`strict actual model/tier identity must match the approved route (${JSON.stringify(mismatch)}, stream=${stream})`, async t => {
  const f = await setup(t, { stream, ...mismatch })
  const request = async () => {
    if (!stream) return f.request()
    for await (const _chunk of requestProviderStream({ configState: f.configState, model: 'budgetmodel', system: 'Fixture.', messages: [{ role: 'user', content: 'hello' }], tools: [] })) { /* consume */ }
  }
  const result = await withRequestBudget({ budgetUsd: ALLOW_ONE, deadlineAt: Date.now() + 60000 }, async () => {
    await assert.rejects(request(), error => error.code === 'BUDGET_PROVIDER_IDENTITY' && error.operationNotStarted === false && /固定版本模型/.test(error.message))
    await assert.rejects(request(), { code: 'TASK_BUDGET_EXHAUSTED' })
  })
  assert.equal(f.calls(), 1); assert.equal(result.costUsd, RESERVATION); assert.equal(result.uncertain, true)
})

for (const lateIdentity of [{ model: 'unapproved-late-model' }, { service_tier: 'priority' }]) test(`an identity conflict after the usage frame cannot retain stale billing proof: ${JSON.stringify(lateIdentity)}`, async t => {
  const f = await setup(t, { stream: true, lateIdentity })
  const result = await withRequestBudget({ budgetUsd: ALLOW_ONE, deadlineAt: Date.now() + 60000 }, async () => {
    await assert.rejects(async () => { for await (const _chunk of requestProviderStream({ configState: f.configState, model: 'budgetmodel', system: 'Fixture.', messages: [{ role: 'user', content: 'hello' }], tools: [] })) { /* consume */ } }, { code: 'BUDGET_PROVIDER_IDENTITY' })
  })
  assert.equal(f.calls(), 1); assert.equal(result.uncertain, true); assert.equal(result.costUsd, RESERVATION)
})
