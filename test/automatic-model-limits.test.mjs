import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { loadConfig } from '../src/config/load-config.mjs'
import { withoutModelTokenLimits } from '../src/config/model-token-limits.mjs'
import { discoverModelsForProvider, clearModelCatalogMemoryCache } from '../src/kernel/provider/model-catalog.mjs'
import { requestProvider } from '../src/kernel/provider/router.mjs'
import { runtimeParameters, modelRuntimeProfile } from '../src/kernel/provider/runtime-parameters.mjs'
import { resolveProviderRouteSettings } from '../src/kernel/provider/route-settings.mjs'
import { updateDeviceSettings } from '../src/device/model-settings.mjs'
import { runProviderEditForm } from '../src/kernel/provider/wizard-form.mjs'
import { writeConfigFile } from '../src/repl/config-persistence.mjs'

const legacy = () => ({ provider: { default: 'p', model_context: { large: 32768 }, p: {
  type: 'openai-compatible', base_url: 'https://automatic.example.test/v1', api_key_env: '', default_model: 'large',
  context_limit: 32768, max_tokens: 8192, max_output_tokens: 16384,
  model_options: { large: { thinking_effort: 'high' } }
} }, permission: { level: 'manual' } })

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-auto-limits-'))
  const home = path.join(root, 'state'), cwd = path.join(root, 'project')
  await mkdir(home); await mkdir(cwd)
  const previous = process.env.KKCODE_HOME, oldFetch = global.fetch
  process.env.KKCODE_HOME = home
  t.after(async () => {
    global.fetch = oldFetch
    if (previous === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previous
    clearModelCatalogMemoryCache()
    await rm(root, { recursive: true, force: true })
  })
  return { home, cwd, file: path.join(home, 'config.yaml'), service: { cwd, turns: new Map(), kernels: new Map(), emit() {} } }
}

test('old file limits cannot cap API values, refreshed catalogs or actual provider requests', async t => {
  const f = await fixture(t), original = YAML.stringify(legacy())
  await writeFile(f.file, original)
  let output = 131072
  const bodies = []
  global.fetch = async (url, options) => {
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'large', context_length: 1048576, max_output_tokens: output, reasoning_effort_levels: ['low', 'high'] }] }))
    bodies.push(JSON.parse(options.body))
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'fixture' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  }
  const state = await loadConfig(f.cwd)
  await discoverModelsForProvider(state, { refresh: true })
  const settings = resolveProviderRouteSettings(state, 'p', { model: 'large' })
  assert.equal(modelRuntimeProfile(state, settings).context.limit, 1048576)
  assert.equal(modelRuntimeProfile(state, settings).output.reserved, 131072)
  await requestProvider({ configState: state, providerType: 'p', model: 'large', system: '', messages: [], tools: [] })
  assert.equal(bodies.at(-1).max_tokens, 131072)
  assert.equal(bodies.at(-1).reasoning_effort, 'high')
  output = 65536
  await discoverModelsForProvider(state, { refresh: true })
  assert.equal(runtimeParameters(state, settings).params.maxTokens, 65536)
  assert.equal(runtimeParameters(state, settings, { maxTokens: 256 }).params.maxTokens, 256, 'explicit request budgets remain bounded')
  assert.equal(await readFile(f.file, 'utf8'), original, 'reading metadata must not rewrite user files')
})

test('user, project and env legacy caps are ignored; sparse metadata uses the client estimate', async t => {
  const f = await fixture(t)
  await writeFile(f.file, YAML.stringify(legacy()))
  await writeFile(path.join(f.cwd, 'kkcode.config.json'), JSON.stringify({ provider: { p: { context_limit: 8192, max_tokens: 1024 } } }))
  await writeFile(path.join(f.cwd, '.env'), 'KKCODE_PROVIDER__P__MAX_TOKENS=512\nKKCODE_PROVIDER__P__CONTEXT_LIMIT=4096\n')
  const state = await loadConfig(f.cwd)
  global.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'large', context_length: 1048576 }] }))
  // The user route is unchanged; this fixture trusts only its own project.
  state.workspaceTrust = { trusted: true }
  await discoverModelsForProvider(state, { refresh: true })
  const runtime = modelRuntimeProfile(state, resolveProviderRouteSettings(state, 'p', { model: 'large' }))
  assert.equal(runtime.output.reserved, Math.floor(1048576 / 5))
  assert.equal(runtime.output.source, 'estimated')
  for (const config of [state.config, state.userConfig, state.source.projectRaw, state.source.envOverlay]) {
    assert.equal(config.provider?.p?.max_tokens, undefined)
    assert.equal(config.provider?.p?.context_limit, undefined)
    assert.equal(config.provider?.model_context, undefined)
  }
})

test('device saves clear old numbers while retaining credentials, effort and permission restrictions', async t => {
  const f = await fixture(t), input = legacy()
  input.provider.p.api_key = 'fixture-private-key'
  await writeFile(f.file, YAML.stringify(input))
  const result = await updateDeviceSettings(f.service, { provider: { p: { max_tokens: 128, model_options: { large: { thinking_effort: 'low' } } } } })
  const saved = YAML.parse(await readFile(f.file, 'utf8'))
  assert.deepEqual(saved, withoutModelTokenLimits({ ...input, provider: { ...input.provider, p: { ...input.provider.p, model_options: { large: { thinking_effort: 'low' } } } } }))
  assert.equal(result.config.provider.p.api_key, '[REDACTED]')
  assert.equal(result.config.provider.p.max_tokens, undefined)
  const bad = { ...input, permission: { level: 'yolo', rules: [{ tool: '*', action: 'typo' }] } }
  await writeFile(f.file, YAML.stringify(bad))
  assert.equal((await loadConfig(f.cwd)).permissionBlocked, true)
  await assert.rejects(updateDeviceSettings(f.service, { language: 'zh' }), /配置未保存/)
  assert.deepEqual(YAML.parse(await readFile(f.file, 'utf8')), bad)
})

test('editing channels and saving REPL preferences cannot reintroduce numeric limits', async t => {
  const f = await fixture(t), input = legacy()
  await writeFile(f.file, YAML.stringify(input))
  const asked = []
  await runProviderEditForm({ name: 'p', existing: input.provider.p, ask: async ({ questions }) => {
    asked.push(...questions.map(q => q.id))
    return { default_model: 'new-model' }
  } })
  assert.ok(!asked.includes('context_limit') && !asked.includes('max_tokens'))
  const saved = YAML.parse(await readFile(f.file, 'utf8'))
  assert.equal(saved.provider.p.default_model, 'new-model')
  assert.equal(saved.provider.p.max_tokens, undefined)
  assert.equal(saved.provider.model_context, undefined)
  await writeConfigFile(f.file, { ...input, ui: { theme: 'light' } })
  assert.equal(YAML.parse(await readFile(f.file, 'utf8')).provider.p.max_tokens, undefined)
})

test('CLI rejects obsolete cap writes and cleans existing caps on ordinary saves', async t => {
  const f = await fixture(t), project = path.join(f.cwd, 'kkcode.config.yaml')
  const entry = path.resolve('src/index.mjs'), original = YAML.stringify(legacy())
  await writeFile(project, original)
  for (const key of ['provider.model_context.large', 'provider.p.max_tokens', 'provider.p.max_output_tokens', 'provider.p.context_limit', 'provider.p.thinking.budget_tokens']) {
    const result = spawnSync(process.execPath, [entry, 'config', 'set', key, '32768'], { cwd: f.cwd, encoding: 'utf8', env: process.env })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /自动计算/)
    assert.equal(await readFile(project, 'utf8'), original)
  }
  const saved = spawnSync(process.execPath, [entry, 'config', 'set', 'language', 'zh'], { cwd: f.cwd, encoding: 'utf8', env: process.env })
  assert.equal(saved.status, 0, saved.stderr)
  assert.equal(YAML.parse(await readFile(project, 'utf8')).provider.p.max_tokens, undefined)
})

test('legacy thinking-enabled intent survives while its numeric budget follows the current output', async t => {
  const f = await fixture(t)
  await writeFile(f.file, YAML.stringify({ provider: { default: 'p', p: { type: 'anthropic', default_model: 'claude-sonnet-4', thinking: { type: 'enabled', budget_tokens: 8000 } } } }))
  const state = await loadConfig(f.cwd), settings = resolveProviderRouteSettings(state, 'p', { model: 'claude-sonnet-4' })
  assert.deepEqual(state.config.provider.p.thinking, { type: 'enabled' })
  const small = runtimeParameters(state, settings, { maxTokens: 4096 }).params.thinking.budget_tokens
  const large = runtimeParameters(state, settings, { maxTokens: 65536 }).params.thinking.budget_tokens
  assert.ok(small >= 1024 && small < 4096)
  assert.ok(large > small && large < 65536)
  assert.throws(() => runtimeParameters(state, settings, { maxTokens: 512 }), /有效范围/)
})
