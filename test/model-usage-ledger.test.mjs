import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { collectModelUsage, recordModelUsage, priceModelUsage } from '../src/usage/model-ledger.mjs'
import { createKernel } from '../src/kernel/index.mjs'
import { readUsageStore } from '../src/usage/usage-meter.mjs'

test('private request ledger replaces cumulative frames and isolates nested execution scopes', async () => {
  const outer = await collectModelUsage(async () => {
    recordModelUsage({ requestId: 'one', provider: 'a', model: 'm', usage: { input: 10, output: 1 } })
    recordModelUsage({ requestId: 'one', provider: 'a', model: 'm', usage: { input: 10, output: 3 } })
    const nested = await collectModelUsage(async () => recordModelUsage({ requestId: 'inner', provider: 'b', model: 'n', usage: { input: 20, output: 4 } }))
    assert.equal(nested.usage.input, 20)
    return { schema: 'unchanged' }
  })
  assert.deepEqual(outer.usage, { input: 10, output: 3, cacheRead: 0, cacheWrite: 0 })
  assert.deepEqual(outer.result, { schema: 'unchanged' })
  assert.equal(outer.groups.length, 1)
})

test('real kernel turn prices conversation and explicit review separately, and asynchronous title uses its own model rate', { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-role-billing-')), cwd = path.join(root, 'project'), state = path.join(root, 'state')
  await mkdir(cwd); await mkdir(state)
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = state
  const requests = []
  let mainCalls = 0, kernel
  const server = createServer(async (request, response) => {
    const parts = []; for await (const part of request) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts).toString()); requests.push({ url: request.url, body })
    if (request.url.startsWith('/review')) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ choices: [{ message: { content: '{"decision":"allow","reason":"Requested fixture file update"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 5 } }))
    } else if (request.url.startsWith('/title')) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ choices: [{ message: { content: 'Fixture file update' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2 } }))
    } else {
      mainCalls++
      const first = mainCalls === 1
      const delta = first ? { tool_calls: [{ index: 0, id: 'write-guidance', function: { name: 'write', arguments: JSON.stringify({ path: path.join(cwd, 'AGENTS.md'), content: 'Fixture project guidance.\n' }) } }] } : { content: 'Fixture update complete.' }
      response.setHeader('content-type', 'text/event-stream')
      response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await kernel?.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const pricingFile = path.join(root, 'prices.json')
  await writeFile(pricingFile, JSON.stringify({ currency: 'USD', per_tokens: 1, models: {
    'main-fixture': { input: 1, output: 2 }, 'review-fixture': { input: 10, output: 20 }, 'title-fixture': { input: 100, output: 200 }
  } }))
  const provider = (route, model) => ({ type: 'openai-compatible', base_url: `${origin}/${route}/v1`, api_key_env: '', default_model: model, retry_attempts: 0 })
  await writeFile(path.join(state, 'config.json'), JSON.stringify({ provider: { default: 'main', main: provider('main', 'main-fixture'), reviewer: provider('review', 'review-fixture'), titles: provider('title', 'title-fixture') },
    models: { roles: { review: { provider: 'reviewer', model: 'review-fixture' }, title: { provider: 'titles', model: 'title-fixture' } } },
    usage: { pricing_file: pricingFile }, permission: { level: 'accept-edits', auto_review: true }, session: { title_generation: true, recovery: false }, mcp: { auto_discover: false }, skills: { auto_seed: false } }))
  let titleFinished
  const titled = new Promise(resolve => { titleFinished = resolve })
  kernel = await createKernel({ cwd, boot: false, trustState: { trusted: true }, handlers: { onEvent: event => { if (event.type === 'session.title.updated') titleFinished() } } })
  const result = await kernel.executeTurn({ prompt: 'Create AGENTS.md with fixture project guidance.', mode: 'assistant' })
  assert.equal(result.error, null, result.reply)
  assert.equal(await readFile(path.join(cwd, 'AGENTS.md'), 'utf8'), 'Fixture project guidance.\n')
  assert.equal(requests.filter(request => request.url.startsWith('/review')).length, 1)
  assert.deepEqual(result.tokenMeter.turn.input, 240)
  assert.equal(result.tokenMeter.turn.output, 25)
  assert.equal(result.cost, 740, '200*1 + 20*2 conversation + 40*10 + 5*20 review')
  assert.equal(Object.hasOwn(result, 'modelUsage'), false, 'internal ledger must not extend stable result schema')
  await titled
  await kernel.shutdown(); kernel = null
  assert.equal(requests.filter(request => request.url.startsWith('/title')).length, 1)
  const usage = await readUsageStore()
  assert.equal(usage.sessions[result.sessionId].cost, 3140, 'title additionally costs 20*100 + 2*200, not main rate')
  assert.equal(usage.sessions[result.sessionId].input, 260)
  const attributed = Object.values(usage.modelTotals).filter(item => item.sessionId === result.sessionId)
  assert.deepEqual(attributed.map(item => [item.provider, item.model, item.usage.cost]).sort(), [
    ['main', 'main-fixture', 240], ['reviewer', 'review-fixture', 500], ['titles', 'title-fixture', 2400]
  ])
})
