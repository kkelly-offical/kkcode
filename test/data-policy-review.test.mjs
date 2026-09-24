import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { loadConfig } from '../src/config/load-config.mjs'
import { assertProviderDataPolicy, assertWebDataPolicy } from '../src/kernel/permission/data-policy.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-policy-review-'))
  const home = path.join(root, 'home'), cwd = path.join(root, 'project'), previous = process.env.KKCODE_HOME
  await mkdir(home); await mkdir(path.join(cwd, '.kkcode'), { recursive: true })
  process.env.KKCODE_HOME = home
  t.after(async () => { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  return { home, cwd }
}

test('a project env file cannot hide administrator-user env policy with an unrelated setting', async t => {
  const { home, cwd } = await fixture(t)
  await writeFile(path.join(home, '.env'), 'KKCODE_DATA_POLICY__PROVIDERS=[]\nKKCODE_LANGUAGE=en\n')
  await writeFile(path.join(cwd, '.env'), 'KKCODE_LANGUAGE=zh\n')
  const loaded = await loadConfig(cwd)
  assert.equal(loaded.config.language, 'zh', 'ordinary env configuration keeps its established precedence')
  assert.deepEqual(loaded.config.data_policy.providers, [])
  assert.throws(() => assertProviderDataPolicy(loaded, { providerName: 'outside', baseUrl: 'https://outside.test/v1' }), /策略拒绝/)
  loaded.config.data_policy = { providers: ['outside'] }
  assert.throws(() => assertProviderDataPolicy(loaded, { providerName: 'outside', baseUrl: 'https://outside.test/v1' }), /策略拒绝/)
})

test('all relevant env policy ceilings intersect even when the first env supplies ordinary configuration', async t => {
  const { home, cwd } = await fixture(t)
  await writeFile(path.join(home, '.env'), 'KKCODE_DATA_POLICY__PROVIDERS=["local","shared"]\n')
  await writeFile(path.join(cwd, '.kkcode', '.env'), 'KKCODE_DATA_POLICY__PROVIDERS=["shared","enterprise"]\nKKCODE_DATA_POLICY__WEB_ORIGINS=[]\n')
  await writeFile(path.join(cwd, '.env'), 'KKCODE_DATA_POLICY__PROVIDERS=["shared","outside"]\n')
  const loaded = await loadConfig(cwd)
  assert.deepEqual(loaded.config.data_policy.providers, ['shared'])
  assert.throws(() => assertWebDataPolicy(loaded, 'https://outside.test'), /策略拒绝/)
  loaded.config.data_policy = {}
  assert.throws(() => assertWebDataPolicy(loaded, 'https://outside.test'), /策略拒绝/)
})

test('malformed hidden env policy cannot be shadowed by a valid project env', async t => {
  const { home, cwd } = await fixture(t)
  await writeFile(path.join(home, '.env'), 'KKCODE_DATA_POLICY__MODEL_ORIGINS=fixture-secret\n')
  await writeFile(path.join(cwd, '.env'), 'KKCODE_LANGUAGE=zh\n')
  const loaded = await loadConfig(cwd)
  assert.ok(loaded.errors.length)
  assert.doesNotMatch(loaded.errors.join('\n'), /fixture-secret/)
  assert.deepEqual(loaded.config.data_policy.providers, [])
  assert.throws(() => assertWebDataPolicy(loaded, 'https://outside.test'), /策略拒绝/)
})

test('unparseable escaped policy declaration fails closed without exposing parser snippets', async t => {
  const { cwd } = await fixture(t)
  await writeFile(path.join(cwd, '.kkcode', 'config.json'), '{"data_\\u0070olicy":{"providers":[]},"credential":"fixture-secret",bad}')
  const loaded = await loadConfig(cwd)
  assert.ok(loaded.errors.length)
  assert.doesNotMatch(loaded.errors.join('\n'), /fixture-secret/)
  assert.deepEqual(loaded.config.data_policy.providers, [])
})

test('an unfinished policy assignment in a lower-priority env is not treated as absent policy', async t => {
  const { home, cwd } = await fixture(t)
  await writeFile(path.join(home, '.env'), 'KKCODE_DATA_POLICY__PROVIDERS\n')
  await writeFile(path.join(cwd, '.env'), 'KKCODE_LANGUAGE=zh\n')
  const loaded = await loadConfig(cwd)
  assert.ok(loaded.errors.length)
  assert.deepEqual(loaded.config.data_policy.providers, [])
})
