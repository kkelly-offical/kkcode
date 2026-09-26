import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { loadConfig } from '../src/config/load-config.mjs'
import { evaluatePermission } from '../src/kernel/permission/rules.mjs'
import { applyPermissionLevel } from '../src/repl/permission-flow.mjs'
import { configurationDiagnostics } from '../src/config/diagnostics.mjs'
import { deviceSettingsSnapshot, updateDeviceSettings } from '../src/device/model-settings.mjs'
import { bootstrapKernelExtensions } from '../src/context.mjs'
import { createPermissionEngine } from '../src/kernel/permission/engine.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-config-recovery-'))
  const home = path.join(root, 'state'), cwd = path.join(root, 'project')
  await mkdir(home); await mkdir(cwd)
  const previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  })
  return { home, cwd, file: path.join(home, 'config.json'), service: { cwd, turns: new Map(), kernels: new Map(), emit() {} } }
}

const provider = { default: 'local-fixture', 'local-fixture': {
  type: 'openai-compatible', base_url: 'https://models.example.invalid/v1', api_key: 'fixture-private-credential', default_model: 'fixture-model'
} }

test('invalid permission preserves unrelated configuration but no mode can run a tool', async t => {
  const f = await fixture(t)
  await writeFile(f.file, JSON.stringify({ provider, agent: { max_steps: 23 }, permission: { level: 'yolo', rules: [{ tool: '*', action: 'typo' }] } }))
  const state = await loadConfig(f.cwd)
  assert.equal(state.config.provider.default, 'local-fixture')
  assert.equal(state.config.agent.max_steps, 23)
  assert.equal(state.source.userRaw.provider.default, 'local-fixture')
  assert.equal(state.source.userRaw.permission, undefined)
  assert.equal(state.permissionBlocked, true)
  for (const level of ['readonly', 'manual', 'accept-edits', 'yolo']) for (const tool of ['read', 'write', 'bash', 'task']) {
    const config = { ...state.config, permission: applyPermissionLevel(level, state.config.permission) }
    const decision = evaluatePermission({ config, tool, mode: 'agent', command: 'pwd' })
    assert.equal(decision.action, 'deny', `${level}/${tool}`)
    assert.equal(decision.source, 'invalid_permission_config')
  }
})

test('later project/env layers cannot unlock broken user permission or hide valid settings', async t => {
  const f = await fixture(t)
  await writeFile(f.file, JSON.stringify({ provider, permission: { default_policy: 'allow' } }))
  await writeFile(path.join(f.cwd, 'kkcode.config.json'), JSON.stringify({ permission: { level: 'yolo', _load_error: false }, agent: { ultra: { max_iterations: 7 } } }))
  await writeFile(path.join(f.cwd, '.env'), 'KKCODE_PERMISSION__LEVEL=yolo\nKKCODE_PERMISSION___LOAD_ERROR=false\n')
  const state = await loadConfig(f.cwd)
  assert.equal(state.permissionBlocked, true)
  assert.equal(state.config.permission._load_error, true)
  assert.equal(state.userConfig.permission._load_error, true)
  assert.equal(state.config.agent.longagent.max_iterations, 7)
  assert.equal(state.config.provider.default, 'local-fixture')
})

test('malformed project permission does not contaminate the independent user policy', async t => {
  const f = await fixture(t)
  await writeFile(f.file, JSON.stringify({ provider, permission: { level: 'readonly' } }))
  await writeFile(path.join(f.cwd, 'kkcode.config.json'), JSON.stringify({ permission: { sandbox: { mode: 'misspelled' } }, agent: { ultra: { max_iterations: 9 } } }))
  const state = await loadConfig(f.cwd)
  assert.equal(state.config.agent.longagent.max_iterations, 9)
  assert.equal(state.config.permission._load_error, true)
  assert.equal(state.userConfig.permission._load_error, undefined)
  assert.equal(state.userConfig.permission.level, 'readonly')
})

test('settings exposes safe diagnostics and does not claim an ineffective save succeeded', async t => {
  const f = await fixture(t)
  const original = JSON.stringify({ provider, permission: { default_policy: 'allow' } })
  await writeFile(f.file, original)
  const snapshot = await deviceSettingsSnapshot(f.cwd)
  assert.equal(snapshot.provider.default, 'local-fixture')
  assert.equal(snapshot.provider['local-fixture'].api_key, '[REDACTED]')
  assert.equal(snapshot._diagnostics.toolsBlocked, true)
  assert.equal(snapshot._diagnostics.errors[0].field, 'permission.default_policy')
  assert.match(snapshot._diagnostics.errors[0].message, /手动迁移/)
  assert.ok(!JSON.stringify(snapshot).includes('fixture-private-credential'))
  await assert.rejects(updateDeviceSettings(f.service, { provider: { 'local-fixture': { default_model: 'replacement' } } }), error => error.code === 'invalid_config' && /配置未保存/.test(error.message))
  assert.equal(await readFile(f.file, 'utf8'), original)
  await writeFile(f.file, JSON.stringify({ provider, permission: { level: 'manual' } }))
  const saved = await updateDeviceSettings(f.service, { provider: { 'local-fixture': { default_model: 'replacement' } } })
  assert.equal(saved.saved, true)
  assert.equal(saved.config.provider['local-fixture'].default_model, 'replacement')
  assert.equal(saved.config._diagnostics.toolsBlocked, false)
  assert.deepEqual(saved.config._diagnostics.errors, [])
  assert.equal((await loadConfig(f.cwd)).permissionBlocked, false)
})

test('diagnostics never project malformed secrets or file paths and cannot be written as config', async t => {
  const f = await fixture(t)
  const state = { source: { userPath: '/private/fixture-secret/config.json' }, permissionBlocked: true,
    errors: ['/private/fixture-secret/config.json: permission.level: fixture-private-credential', '/private/fixture-secret/config.json: provider.fixture-secret.api_key: fixture-private-credential'] }
  const text = JSON.stringify(configurationDiagnostics(state))
  assert.ok(!text.includes('fixture-secret'))
  assert.ok(!text.includes('fixture-private-credential'))
  for (const patch of [{ _diagnostics: {} }, { permission: { _load_error: false } }]) {
    await assert.rejects(updateDeviceSettings(f.service, patch), error => error.code === 'invalid_config')
  }
})

test('cached approvals and extension boot cannot bypass invalid permission configuration', async t => {
  const f = await fixture(t), engine = createPermissionEngine({ promptChannel: { askPermissionInteractive: async () => 'allow_session' } })
  engine.setTrusted(true)
  await engine.check({ config: { permission: { level: 'manual' } }, tool: 'write', sessionId: 'cached', pattern: 'safe.txt', workspace: f.cwd, mode: 'agent' })
  await writeFile(f.file, JSON.stringify({ provider, permission: { level: 'yolo', rules: [{ tool: '*', action: 'invalid' }] } }))
  const state = await loadConfig(f.cwd)
  await assert.rejects(engine.check({ config: state.config, tool: 'write', sessionId: 'cached', pattern: 'safe.txt', workspace: f.cwd, mode: 'agent' }), /invalid_permission_config/)
  let initialized = false
  await assert.rejects(bootstrapKernelExtensions({ cwd: f.cwd, configState: state, trustState: { trusted: true },
    registries: { permissions: { setTrusted() { initialized = true } } } }), /工具与扩展启动已暂停/)
  assert.equal(initialized, false)
})

test('malformed or unsafe-policy files cannot hide a permission error or overwrite the original on save', async t => {
  const f = await fixture(t)
  for (const text of ['{malformed fixture-private-credential', JSON.stringify({ provider, data_policy: 'invalid', permission: { level: 'yolo', rules: false } })]) {
    await writeFile(f.file, text)
    const state = await loadConfig(f.cwd)
    assert.equal(state.permissionBlocked, true)
    assert.equal(evaluatePermission({ config: state.config, tool: 'bash', mode: 'yolo', command: 'pwd' }).action, 'deny')
    await assert.rejects(updateDeviceSettings(f.service, { provider }), error => error.code === 'invalid_config' && !error.message.includes('fixture-private-credential'))
    assert.equal(await readFile(f.file, 'utf8'), text)
  }
})

test('an ambiguous non-permission error cannot discard restrictive rules and unlock tools', async t => {
  const f = await fixture(t)
  await writeFile(f.file, JSON.stringify({ provider: { default: 'ambiguous.name', 'ambiguous.name': { type: 'openai', protocol: 'invalid-protocol' } },
    permission: { level: 'readonly', rules: [{ tool: '*', action: 'deny' }] } }))
  const state = await loadConfig(f.cwd)
  assert.ok(state.errors.length)
  assert.equal(state.permissionBlocked, true)
  const config = { ...state.config, permission: applyPermissionLevel('yolo', state.config.permission) }
  assert.equal(evaluatePermission({ config, tool: 'write', mode: 'agent' }).action, 'deny')
})

test('an explicitly empty null document remains a valid editable configuration', async t => {
  const f = await fixture(t)
  await writeFile(f.file, 'null\n')
  assert.deepEqual((await loadConfig(f.cwd)).errors, [])
  const result = await updateDeviceSettings(f.service, { provider })
  assert.equal(result.saved, true)
  assert.equal(result.config.provider.default, 'local-fixture')
})

test('false and numeric YAML documents are not silently replaced by an empty object during save', async t => {
  const f = await fixture(t), file = path.join(f.home, 'config.yaml')
  for (const raw of ['false\n', '0\n']) {
    await writeFile(file, raw)
    assert.ok((await loadConfig(f.cwd)).errors.length)
    await assert.rejects(updateDeviceSettings(f.service, { provider }), error => error.code === 'invalid_config')
    assert.equal(await readFile(file, 'utf8'), raw)
  }
})
