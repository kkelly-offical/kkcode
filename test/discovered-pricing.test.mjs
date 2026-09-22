import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { discoverModelsForProvider, clearModelCatalogMemoryCache } from '../src/kernel/provider/model-catalog.mjs'
import { parseCatalogEntryPricing } from '../src/kernel/provider/model-capabilities.mjs'
import { loadPricing, calculateCost } from '../src/usage/pricing.mjs'

test('pricing parser rejects null/empty/bool rates and normalizes units/cache prices', () => {
  for (const value of [null, '', false, true, '   ', -1, 'NaN']) assert.equal(parseCatalogEntryPricing({ pricing: { input: value, output: value } }), null)
  assert.deepEqual(parseCatalogEntryPricing({ pricing: { input: 0.002, output: 0.004, per_tokens: 1000, cache_read: 0.001 } }), { input: 2, output: 4, cache_read: 1, currency: 'USD', perTokens: 1000000 })
  assert.equal(parseCatalogEntryPricing({ pricing: { prompt: '0', completion: '0' } }).input, 0, 'explicit free pricing is valid')
})

test('discovered prices feed costs with provider isolation, explicit overrides and stale/currency diagnostics', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kkcode-price-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = home; clearModelCatalogMemoryCache()
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    const provider = req.url.split('/')[1]
    res.end(JSON.stringify({ data: [{ id: 'shared-model', pricing: { input: provider === 'a' ? 2 : 8, output: 12, cache_read: 0.5, cache_write: 3, currency: provider === 'foreign' ? 'EUR' : 'USD' } }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    clearModelCatalogMemoryCache(); await rm(home, { recursive: true, force: true })
  })
  const config = { provider: { default: 'a' } }
  for (const name of ['a', 'b', 'foreign']) config.provider[name] = { type: 'openai-compatible', base_url: `http://127.0.0.1:${server.address().port}/${name}/v1`, api_key_env: '', discovery: { cache_ttl_ms: 5000 } }
  const state = { config, source: { userRaw: {}, projectRaw: {}, userDir: home } }
  for (const providerName of ['a', 'b', 'foreign']) await discoverModelsForProvider(state, { providerName, refresh: true, now: 1000 })
  for (const [providerName, expected] of [['a', 2], ['b', 8]]) {
    const info = await loadPricing(state, { providerName, model: 'shared-model', now: 2000 })
    assert.equal(info.source, 'catalog')
    assert.equal(calculateCost(info.pricing, 'shared-model', { input: 1000000 }).amount, expected)
    assert.equal(calculateCost(info.pricing, 'shared-model', { cacheRead: 1000000 }).amount, 0.5)
  }
  const stale = await loadPricing(state, { providerName: 'a', model: 'shared-model', now: 10000 })
  assert.equal(stale.source, 'catalog-stale')
  assert.equal(calculateCost(stale.pricing, 'shared-model', { input: 1 }).unknown, true)
  const foreign = await loadPricing(state, { providerName: 'foreign', model: 'shared-model', now: 2000 })
  assert.equal(foreign.source, 'default')
  assert.match(foreign.errors[0], /EUR.*USD/)
  const file = path.join(home, 'pricing.json')
  await writeFile(file, JSON.stringify({ models: { 'shared-model': { input: 1, output: 2 } } }))
  state.source.userRaw = { usage: { pricing_file: 'pricing.json' } }
  const overridden = await loadPricing(state, { providerName: 'a', model: 'shared-model', now: 2000 })
  assert.equal(overridden.source, file)
  assert.equal(calculateCost(overridden.pricing, 'shared-model', { input: 1000000 }).amount, 1)
  await writeFile(file, JSON.stringify({ per_tokens: 1000, models: { 'shared-model': { input: 0.001, output: 0.002 } } }))
  const unit = await loadPricing(state, { providerName: 'a', model: 'shared-model', now: 2000 })
  assert.equal(calculateCost(unit.pricing, 'shared-model', { input: 1000000 }).amount, 1)
  assert.equal(calculateCost(unit.pricing, 'gpt-4o', { input: 1000000 }).amount, 2.5, 'built-in fallback retains its original unit')
  assert.equal(calculateCost(unit.pricing, 'constructor', { input: 1000000 }).unknown, true, 'prototype names are not free models')
  await writeFile(file, JSON.stringify({ models: { 'shared-model': { input: -1, output: 2 } } }))
  const invalid = await loadPricing(state, { providerName: 'a', model: 'shared-model', now: 2000 })
  assert.ok(invalid.errors.length)
  assert.equal(calculateCost(invalid.pricing, 'shared-model', { input: 1 }).unknown, true)
})
