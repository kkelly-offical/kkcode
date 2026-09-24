import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { once } from 'node:events'
import { normalizeDataPolicy, intersectDataPolicies, assertProviderDataPolicy, assertWebDataPolicy } from '../src/kernel/permission/data-policy.mjs'
import { loadConfig } from '../src/config/load-config.mjs'
import { validateConfig } from '../src/config/schema.mjs'
import { createProviderRegistry } from '../src/kernel/provider/router.mjs'
import { discoverModelsForProvider } from '../src/kernel/provider/model-catalog.mjs'
import { BrowserNetwork } from '../src/kernel/browser/network.mjs'
import { guardedFetch } from '../src/net/url-guard.mjs'
import { BackgroundManager } from '../src/kernel/orchestration/background-manager.mjs'
import { EventBus } from '../src/kernel/core/events.mjs'
import { EVENT_TYPES } from '../src/kernel/core/constants.mjs'

async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-policy-'))
  const disposals = []
  const old = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'home')
  await mkdir(process.env.KKCODE_HOME)
  await mkdir(path.join(root, 'project', '.kkcode'), { recursive: true })
  t.after(async () => {
    // Node after-hooks are FIFO. Drain resources before removing their cwd;
    // Windows correctly refuses deletion while a worker still owns it.
    const failures = []
    for (const dispose of disposals.reverse()) {
      try { await dispose() } catch (error) { failures.push(error) }
    }
    if (old === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = old
    if (failures.length) throw new AggregateError(failures, 'Policy fixture resources did not close; preserving its directory')
    await rm(root, { recursive: true, force: true })
  })
  return { root, cwd: path.join(root, 'project'), user: path.join(root, 'home', 'config.json'), project: path.join(root, 'project', '.kkcode', 'config.json'), disposeBeforeRemove: dispose => disposals.push(dispose) }
}

function state(policy, type = 'openai-compatible', endpoint = 'https://model.example.test/v1') {
  return { config: { data_policy: policy, provider: { default: 'local', local: {
    type, protocol: type === 'anthropic' ? 'anthropic' : 'openai', base_url: endpoint,
    api_key_env: '', default_model: 'fixture-model', retry_attempts: 0
  } } }, source: {} }
}

test('policy omission preserves behavior; origins normalize without path or credential grants', () => {
  assert.equal(normalizeDataPolicy(undefined), undefined)
  assert.doesNotThrow(() => assertProviderDataPolicy(state(undefined), { providerName: 'local', baseUrl: 'http://127.0.0.1:8000/v1' }))
  assert.deepEqual(normalizeDataPolicy({ model_origins: ['https://MODEL.example.test:443/'] }), { model_origins: ['https://model.example.test'] })
  for (const policy of [null, [], { providers: '*' }, { models: [] }, { providers: ['*'] }, { model_origins: ['https://example.test/v1'] }, { web_origins: ['https://name:fixture-secret@example.test/?token=fixture-secret'] }]) {
    assert.throws(() => normalizeDataPolicy(policy), error => {
      assert.doesNotMatch(error.message, /fixture-secret/)
      return error.code === 'data_policy_invalid'
    })
    assert.equal(validateConfig({ data_policy: policy }).valid, false)
  }
})

test('intersections never widen and empty allowlists deny', () => {
  const policy = intersectDataPolicies({ providers: ['a', 'b'], model_origins: ['https://a.test'] }, { providers: ['b', 'c'] }, {})
  assert.deepEqual(policy, { providers: ['b'], model_origins: ['https://a.test'] })
  assert.throws(() => assertProviderDataPolicy({ data_policy: { providers: [] } }, { providerName: 'a', baseUrl: 'https://a.test' }), /策略拒绝/)
  assert.throws(() => assertWebDataPolicy({ data_policy: { web_origins: [] } }, 'https://a.test'), /策略拒绝/)
})

test('admin, user, project and env policies intersect in loadConfig', async t => {
  const dir = await directory(t)
  await writeFile(dir.user, JSON.stringify({ data_policy: { providers: ['a', 'b', 'c'], model_origins: ['https://model.test'] } }))
  await writeFile(dir.project, JSON.stringify({ data_policy: { providers: ['b', 'c', 'd'] } }))
  await writeFile(path.join(dir.cwd, '.env'), 'KKCODE_DATA_POLICY__PROVIDERS=["c","d"]\n')
  const loaded = await loadConfig(dir.cwd, { adminDataPolicy: { providers: ['a', 'c'], model_origins: ['https://model.test'] } })
  assert.deepEqual(loaded.errors, [])
  assert.deepEqual(loaded.config.data_policy, { providers: ['c'], model_origins: ['https://model.test'] })
  // An in-memory provider/config switch cannot discard the inherited ceiling.
  loaded.config.data_policy = { providers: ['d'] }
  assert.throws(() => assertProviderDataPolicy(loaded, { providerName: 'd', baseUrl: 'https://model.test' }), /策略拒绝/)
})

test('malformed policy is visible and deny-all, not pruned or replaced by env', async t => {
  const dir = await directory(t)
  await writeFile(dir.user, JSON.stringify({ data_policy: { providers: ['local'] } }))
  await writeFile(dir.project, JSON.stringify({ data_policy: { model_origins: 'https://example.test' } }))
  await writeFile(path.join(dir.cwd, '.env'), 'KKCODE_DATA_POLICY__PROVIDERS=["local"]\n')
  const loaded = await loadConfig(dir.cwd)
  assert.ok(loaded.errors.some(error => /data_policy/.test(error)))
  assert.deepEqual(loaded.config.data_policy.providers, [])
  assert.deepEqual(loaded.config.data_policy.web_origins, [])
  assert.throws(() => assertProviderDataPolicy(loaded, { providerName: 'local', baseUrl: 'https://example.test' }), /策略拒绝/)
})

test('an unrelated invalid permission field cannot erase a valid project restriction', async t => {
  const dir = await directory(t)
  await writeFile(dir.project, JSON.stringify({ data_policy: { providers: [] }, permission: { level: 'invalid' } }))
  const loaded = await loadConfig(dir.cwd)
  assert.ok(loaded.errors.length)
  assert.deepEqual(loaded.config.data_policy.providers, [])
})

test('malformed policy-bearing YAML and malformed env fail closed without values in errors', async t => {
  const dir = await directory(t)
  await writeFile(path.join(dir.cwd, '.kkcode', 'config.yaml'), 'data_policy: [broken\n  secret: fixture-secret\n')
  let loaded = await loadConfig(dir.cwd)
  assert.deepEqual(loaded.config.data_policy.providers, [])
  assert.doesNotMatch(loaded.errors.join('\n'), /fixture-secret/)
  await rm(path.join(dir.cwd, '.kkcode', 'config.yaml'))
  await writeFile(path.join(dir.cwd, '.env'), 'KKCODE_DATA_POLICY__PROVIDERS=fixture-secret\n')
  loaded = await loadConfig(dir.cwd)
  assert.deepEqual(loaded.config.data_policy.providers, [])
  assert.doesNotMatch(loaded.errors.join('\n'), /fixture-secret/)
})

test('invalid host administrator policy rejects load instead of reverting to defaults', async t => {
  const dir = await directory(t)
  await assert.rejects(loadConfig(dir.cwd, { adminDataPolicy: { model_origins: ['*'] } }), error => error.code === 'data_policy_invalid')
})

test('all provider routes reject disallowed origins before inference/count, including unaudited auxiliaries', async t => {
  await directory(t)
  const registry = createProviderRegistry()
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = async () => { calls++; throw new Error('unexpected network') }
  t.after(() => { globalThis.fetch = original })
  for (const type of ['openai', 'openai-compatible', 'openai-responses', 'anthropic', 'ollama', 'gateway']) {
    const configState = state({ model_origins: ['https://allowed.test'] }, type)
    const args = { configState, system: 'title/review/compaction fixture', messages: [], tools: [], audit: false }
    await assert.rejects(registry.requestProvider(args), error => error.code === 'data_policy_denied')
    await assert.rejects(async () => { for await (const _ of registry.requestProviderStream(args)) { /* must not yield */ } }, error => error.code === 'data_policy_denied')
    await assert.rejects(registry.countTokensProvider(args), error => error.code === 'data_policy_denied')
  }
  assert.equal(calls, 0)
})

test('provider-name and endpoint overrides cannot reuse an allowed provider grant', async t => {
  await directory(t)
  const registry = createProviderRegistry()
  const configState = state({ providers: ['local'], model_origins: ['https://model.example.test'] })
  configState.config.provider.other = { ...configState.config.provider.local }
  for (const override of [{ providerType: 'other' }, { baseUrl: 'https://outside.test/v1' }]) {
    await assert.rejects(registry.requestProvider({ configState, messages: [], tools: [], ...override }), /策略拒绝/)
  }
})

test('allowed authless local vLLM performs a real request; provider redirects remain rejected', async t => {
  await directory(t)
  let requests = 0
  const server = http.createServer((req, res) => {
    requests++
    assert.equal(req.headers.authorization, undefined)
    if (req.url.startsWith('/redirect')) { res.writeHead(307, { location: '/v1/chat/completions' }); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'local success' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const origin = `http://127.0.0.1:${server.address().port}`
  const configState = state({ providers: ['local'], model_origins: [origin] }, 'openai-compatible', `${origin}/v1`)
  const registry = createProviderRegistry()
  const response = await registry.requestProvider({ configState, messages: [], tools: [], audit: false })
  assert.ok(JSON.stringify(response).includes('local success'))
  assert.equal(requests, 1)
  await assert.rejects(registry.requestProvider({ configState, baseUrl: `${origin}/redirect`, messages: [], tools: [], audit: false }), /fetch|redirect/i)
  assert.equal(requests, 2)
})

test('model discovery checks its dedicated endpoint before network/cache', async t => {
  await directory(t)
  const configState = state({ providers: ['local'], model_origins: ['https://model.example.test'] })
  configState.config.provider.local.endpoints = { models: 'https://outside.test/models' }
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = async () => { calls++; throw new Error('unexpected network') }
  t.after(() => { globalThis.fetch = original })
  await assert.rejects(discoverModelsForProvider(configState, { refresh: true }), /策略拒绝/)
  assert.equal(calls, 0)
})

test('web policy checks every redirect before the new origin receives data', async t => {
  let secondCalls = 0
  const second = http.createServer((_req, res) => { secondCalls++; res.end('unexpected') })
  second.listen(0, '127.0.0.1'); await once(second, 'listening')
  const first = http.createServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${second.address().port}/` }); res.end() })
  first.listen(0, '127.0.0.1'); await once(first, 'listening')
  t.after(() => { for (const server of [first, second]) { server.closeAllConnections(); server.close() } })
  const origin = `http://127.0.0.1:${first.address().port}`
  const config = { data_policy: { web_origins: [origin] } }
  await assert.rejects(guardedFetch(origin, {}, { allowPrivate: true, assertTarget: url => assertWebDataPolicy(config, url.href) }), /策略拒绝/)
  assert.equal(secondCalls, 0)
})

test('Browser target policy applies before DNS and policy changes cancel old resource scope', async () => {
  let lookups = 0
  const network = new BrowserNetwork({ lookup: async () => { lookups++; return [{ address: '8.8.8.8', family: 4 }] } })
  network.setDataPolicy({ web_origins: ['https://allowed.test'] })
  await network.target('https://allowed.test')
  await assert.rejects(network.target('https://blocked.test'), /策略拒绝/)
  assert.equal(lookups, 1)
  const old = network.controller.signal
  network.setDataPolicy({ web_origins: [] })
  assert.equal(old.aborted, true)
  await assert.rejects(network.target('https://allowed.test'), /策略拒绝/)
  network.close()
})

test('HTTP, webfetch and external search tools return policy denial with no request', async t => {
  await directory(t)
  const { ToolRegistry } = await import('../src/kernel/tool/registry.mjs')
  const config = { data_policy: { web_origins: [] }, tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } } }
  await ToolRegistry.initialize({ config, cwd: process.cwd(), force: true, allowProjectSources: false })
  for (const [tool, args] of [['http_request', { url: 'https://blocked.invalid', method: 'POST', body: 'fixture' }], ['webfetch', { url: 'https://blocked.invalid' }], ['websearch', { query: 'fixture' }], ['codesearch', { query: 'fixture' }]]) {
    const result = await ToolRegistry.call(tool, args, { config, cwd: process.cwd() })
    assert.match(result.output, /策略拒绝/, tool)
  }
})

test('background workers inherit parent policy even when disk config allows the endpoint', { timeout: 20000 }, async t => {
  const dir = await directory(t)
  let calls = 0
  const server = http.createServer((_req, res) => { calls++; res.end('unexpected') })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  dir.disposeBeforeRemove(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  // The terminal checkpoint is written before worker shutdown. The parent's
  // TASK_SETTLED notification follows exit, and therefore also releases cwd.
  let task, resolveExit, timer
  const observed = new Set()
  const exited = new Promise(resolve => { resolveExit = resolve })
  const unsubscribe = EventBus.subscribe(event => {
    if (event.type !== EVENT_TYPES.TASK_SETTLED) return
    observed.add(event.payload.id)
    if (event.payload.id === task?.id) resolveExit()
  })
  dir.disposeBeforeRemove(async () => {
    try {
      if (task) {
        await BackgroundManager.cancel(task.id)
        await Promise.race([exited, new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Fixture worker did not exit before directory cleanup')), 15000)
        })])
      }
    } finally { clearTimeout(timer); unsubscribe() }
  })
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const disk = state(undefined, 'openai-compatible', endpoint).config
  disk.tool = { sources: { builtin: true, local: false, plugin: false, mcp: false } }
  await writeFile(dir.user, JSON.stringify(disk))
  task = await BackgroundManager.launchDelegateTask({
    description: 'policy inheritance fixture',
    payload: { cwd: dir.cwd, prompt: 'must not send', subSessionId: 'policy-child', providerType: 'local', dataPolicy: { model_origins: [endpoint] } },
    config: { data_policy: { model_origins: [] }, background: { mode: 'worker_process', max_parallel: 1, worker_timeout_ms: 10000 } }
  })
  if (observed.has(task.id)) resolveExit()
  assert.deepEqual(task.payload.dataPolicy.model_origins, [])
  const settled = await BackgroundManager.waitForTask(task.id, { timeoutMs: 15000, tickMs: 30 })
  assert.equal(settled.status, 'error')
  assert.match(JSON.stringify(settled), /数据出域策略/)
  assert.equal(calls, 0)
})
