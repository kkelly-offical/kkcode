import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import * as models from '@kkelly-offical/kkcode/sdk/models'

const exec = promisify(execFile)
async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-sdk-model-budget-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('public models SDK prepares host price profiles without network, authorization or raw credential disclosure', async t => {
  const root = await temporary(t), prices = path.join(root, 'host-prices.json'), secret = 'fixture-only-model-credential'
  await writeFile(prices, JSON.stringify({ models: { 'sdk-fixed': { input: 0, output: 0, cache_read: 0, cache_write: 0 } } }))
  const state = { source: { userDir: root, userRaw: { usage: { pricing_file: prices } } }, config: { provider: { default: 'host-local', 'host-local': {
    type: 'openai', base_url: 'https://fixture.example.invalid/private-api?tenant=private-test', api_key: secret, default_model: 'sdk-fixed', context_limit: 131072, max_tokens: 4096
  } } } }
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('Public profile preparation must not access the network') })
  const profile = await models.prepareBudgetProfile(state, { providerType: 'host-local', model: 'sdk-fixed' })
  assert.equal(profile.provider, 'host-local'); assert.equal(profile.model, 'sdk-fixed'); assert.equal(profile.protocol, 'openai')
  assert.equal(profile.contextLimit, 131072); assert.equal(profile.maxTokens, 4096)
  assert.deepEqual(profile.rates, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  assert.match(profile.id, /^[a-f0-9]{64}$/); assert.match(profile.scopeHash, /^[a-f0-9]{64}$/)
  assert.deepEqual(await models.prepareBudgetProfiles(state), [profile])
  assert.equal(requests, 0)
  const serialized = JSON.stringify(profile)
  for (const privateValue of [secret, 'private-api', 'tenant=', prices, 'apiKey', 'api_key']) assert.equal(serialized.includes(privateValue), false)
  for (const internal of ['budgetRoute', 'routeBudgetScope', 'selectBudgetProfile', 'normalizeBudgetProfile']) assert.equal(internal in models, false)
})

test('public price factory declarations compose with the branded runs API and reject private scope operators', async t => {
  const root = await temporary(t), source = path.join(root, 'consumer.mts')
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(manifest.exports['./sdk/models'], { types: './src/sdk/models.d.mts', import: './src/sdk/models.mjs' })
  const modelPath = fileURLToPath(new URL('../src/sdk/models.mjs', import.meta.url)).replaceAll('\\', '/')
  const runPath = fileURLToPath(new URL('../src/sdk/runs.mjs', import.meta.url)).replaceAll('\\', '/')
  await writeFile(source, `import { prepareBudgetProfile, prepareBudgetProfiles, type BudgetProfile, type ModelConfigState } from ${JSON.stringify(modelPath)};
import { createLocalFreeInferenceAuthorization, type LocalFreeInferenceAuthorization } from ${JSON.stringify(runPath)};
declare const hostConfigState: ModelConfigState;
const profile: BudgetProfile = await prepareBudgetProfile(hostConfigState, {providerType:'local',model:'fixed',baseUrl:null,apiKeyEnv:'LOCAL_MODEL_KEY'});
profile.rates.cacheRead.toFixed(4);
const profiles: BudgetProfile[] = await prepareBudgetProfiles(hostConfigState);
const authority: LocalFreeInferenceAuthorization = await createLocalFreeInferenceAuthorization({profile,baseUrl:'http://127.0.0.1:1234/v1',apiKeyEnv:'LOCAL_MODEL_KEY',maxRequests:10,maxTokens:100000,authorize:async request=>request.apiFeesUsd===0});
void profiles; void authority;
// @ts-expect-error raw credential overrides are not part of the public selection
await prepareBudgetProfile(hostConfigState,{apiKey:'do-not-accept-inline-key'});
// @ts-expect-error profiles require an actual ConfigState, not only a redacted provider label
await prepareBudgetProfiles({provider:'local'});
// @ts-expect-error the private route/HMAC operator is deliberately not exported
import { routeBudgetScope } from ${JSON.stringify(modelPath)};
`)
  const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
  const result = await exec(process.execPath, [compiler, '--ignoreConfig', '--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--skipLibCheck', 'false', source], { timeout: 30000 })
  assert.equal(result.stdout.trim(), '')
})
