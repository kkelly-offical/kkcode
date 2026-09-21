import test from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { trimTrailingSlashes } from '../src/kernel/provider/url-path.mjs'
import { projectProviderControlReasons } from '../src/kernel/provider/security.mjs'
import { resolveProviderConnection } from '../src/kernel/provider/model-catalog.mjs'
import { createProviderRegistry } from '../src/kernel/provider/router.mjs'

test('provider slash trimming preserves paths, query characters and non-slash suffixes', () => {
  for (const [value, expected] of [
    ['', ''], ['/', ''], ['////', ''], ['https://provider.test/v1///', 'https://provider.test/v1'],
    ['https://provider.test/a//b', 'https://provider.test/a//b'],
    ['https://provider.test/a?value=///', 'https://provider.test/a?value='],
    ['https://provider.test/a#fragment/', 'https://provider.test/a#fragment'],
    ['slashes///\n', 'slashes///\n'], ['windows\\', 'windows\\'], ['全角／', '全角／']
  ]) assert.equal(trimTrailingSlashes(value), expected)
})

test('provider catalog, router and trust-source comparisons keep relative endpoint semantics', async () => {
  const provider = { type: 'openai-compatible', base_url: 'https://provider.test/root///', endpoints: { openai: 'v1///' }, default_model: 'fixture' }
  const state = { config: { provider: { default: 'probe', probe: provider } }, source: { projectRaw: { provider: { probe: { base_url: provider.base_url, endpoints: provider.endpoints } } } } }
  const connection = resolveProviderConnection(state)
  assert.equal(connection.baseUrl, 'https://provider.test/root/v1')
  assert.equal(connection.modelsUrl, 'https://provider.test/root/v1/models')
  assert.deepEqual(projectProviderControlReasons(state, { providerName: 'probe', protocol: 'openai', baseUrlOverride: 'https://provider.test/root/v1/' }), ['project config: provider.probe.base_url', 'project config: provider.probe.endpoints.openai'])
  assert.deepEqual(projectProviderControlReasons(state, { providerName: 'probe', protocol: 'openai', baseUrlOverride: 'https://other.test/v1/' }), [])
  const registry = createProviderRegistry()
  registry.registerProvider('probe', { request: async () => ({}), async *requestStream() {}, countTokens: input => input.baseUrl })
  assert.equal(await registry.countTokensProvider({ configState: state, providerType: 'probe', model: 'fixture' }), connection.baseUrl)
})

test('adversarial long slash runs complete within a bounded worker deadline across all provider paths', { timeout: 10000 }, async () => {
  const modules = Object.fromEntries(['url-path', 'security', 'router', 'model-catalog'].map(name => [name, new URL(`../src/kernel/provider/${name}.mjs`, import.meta.url).href]))
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const [{ trimTrailingSlashes }, { projectProviderControlReasons }, { createProviderRegistry }, { resolveProviderConnection }] = await Promise.all(['url-path', 'security', 'router', 'model-catalog'].map(name => import(workerData[name])));
      const start = performance.now();
      const slashes = '/'.repeat(400000), base = 'https://provider.example.test/' + slashes + 'tail';
      const provider = { type: 'openai-compatible', base_url: base, endpoints: { openai: 'child' }, default_model: 'fixture' };
      const state = { config: { provider: { default: 'probe', probe: provider } }, source: { projectRaw: { provider: { probe: { base_url: base, endpoints: provider.endpoints } } } } };
      const trimmed = trimTrailingSlashes(slashes) === '' && trimTrailingSlashes(slashes + 'x') === slashes + 'x';
      const controlled = projectProviderControlReasons(state, { providerName: 'probe', protocol: 'openai', baseUrlOverride: base + '/child' }).length === 2;
      const connection = resolveProviderConnection(state);
      const registry = createProviderRegistry();
      registry.registerProvider('probe', { request: async () => ({}), async *requestStream() {}, countTokens: input => input.baseUrl });
      const routed = await registry.countTokensProvider({ configState: state, providerType: 'probe', model: 'fixture' });
      parentPort.postMessage({ trimmed, controlled, catalog: connection.modelsUrl === base + '/child/models', routed: routed === base + '/child', elapsedMs: performance.now() - start });
    })().catch(error => { parentPort.postMessage({ error: error.message }); });
  `, { eval: true, workerData: modules })
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Provider URL normalization exceeded the 5 second deadline; possible quadratic backtracking')) }, 5000)
      worker.once('message', message => { clearTimeout(timer); resolve(message) })
      worker.once('error', error => { clearTimeout(timer); reject(error) })
      worker.once('exit', code => { if (code !== 0) { clearTimeout(timer); reject(new Error(`URL normalization worker exited with ${code}`)) } })
    })
    assert.equal(result.error, undefined)
    assert.deepEqual({ trimmed: result.trimmed, controlled: result.controlled, catalog: result.catalog, routed: result.routed }, { trimmed: true, controlled: true, catalog: true, routed: true })
    assert.ok(result.elapsedMs < 3000, `Linear normalization took unexpectedly long: ${result.elapsedMs}ms`)
  } finally { await worker.terminate() }
})
