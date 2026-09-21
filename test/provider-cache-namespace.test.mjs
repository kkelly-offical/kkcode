import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { clearModelCatalogMemoryCache, discoverModelsForProvider } from '../src/kernel/provider/model-catalog.mjs'

test('API-key cache fingerprints partition catalog metadata and never serve as password verifiers', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kkcode-cache-namespace-'))
  const previousHome = process.env.KKCODE_HOME, previousFetch = globalThis.fetch
  process.env.KKCODE_HOME = directory
  clearModelCatalogMemoryCache()
  const keys = ['fixture-credential-alpha', 'fixture-credential-beta']
  let requests = 0
  globalThis.fetch = async (_url, options) => {
    requests++
    const id = options.headers.Authorization === `Bearer ${keys[0]}` ? 'alpha-model' : 'beta-model'
    return new Response(JSON.stringify({ data: [{ id }] }), { headers: { 'content-type': 'application/json' } })
  }
  const state = key => ({ config: { provider: { default: 'fixture', fixture: { type: 'openai-compatible', base_url: 'https://provider.example.test/v1', api_key: key } } } })
  try {
    const first = await discoverModelsForProvider(state(keys[0]), { now: 1000 })
    const second = await discoverModelsForProvider(state(keys[1]), { now: 2000 })
    clearModelCatalogMemoryCache()
    const cached = await discoverModelsForProvider(state(keys[0]), { now: 3000 })
    assert.equal(requests, 2)
    assert.equal(first.models[0].id, 'alpha-model')
    assert.equal(second.models[0].id, 'beta-model')
    assert.equal(cached.source, 'cache')
    assert.equal(cached.models[0].id, 'alpha-model')
    const file = path.join(directory, 'cache', 'models.json'), serialized = await readFile(file, 'utf8'), stored = JSON.parse(serialized)
    assert.equal(Object.keys(stored.entries).length, 2)
    for (const [key, entry] of Object.entries(stored.entries)) {
      assert.match(key, /^[0-9a-f]{64}$/)
      assert.deepEqual(Object.keys(entry).sort(), ['fetchedAt', 'models'])
    }
    for (const key of keys) assert.equal(serialized.includes(key), false)
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
  } finally {
    globalThis.fetch = previousFetch
    if (previousHome === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previousHome
    clearModelCatalogMemoryCache()
    await rm(directory, { recursive: true, force: true })
  }
})
