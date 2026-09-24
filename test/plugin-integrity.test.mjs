import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { installPlugin, managePlugin } from '../src/kernel/plugin/manager.mjs'
import { inspectPluginContent, verifyManagedPlugin } from '../src/kernel/plugin/integrity.mjs'
import { discoverLocalPluginManifests } from '../src/kernel/plugin/manifest-loader.mjs'

async function fixture(t, manifest = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-plugin-integrity-')), source = path.join(root, 'source'), state = path.join(root, 'state')
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = state
  t.after(async () => { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  await mkdir(source); await writeFile(path.join(source, 'plugin.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', ...manifest }))
  return { root, source, state, target: path.join(state, 'plugins', 'fixture') }
}
test('managed executable plugin requires exact-content approval and a no-op update cannot clear it', async t => {
  const f = await fixture(t, { hooks: ['hooks'] }); await mkdir(path.join(f.source, 'hooks'))
  await writeFile(path.join(f.source, 'hooks', 'hook.mjs'), 'export default {name:"fixture",chat:{}}')
  const result = await installPlugin({ name: 'fixture', source: f.source })
  assert.equal(result.pendingApproval, true); assert.equal((await verifyManagedPlugin(f.target)).enabled, false)
  assert.equal((await managePlugin('fixture', 'update')).pendingApproval, true)
  await assert.rejects(managePlugin('fixture', 'enable'), /批准/)
  await assert.rejects(managePlugin('fixture', 'approve', { confirmHash: '0'.repeat(64) }), /confirm-hash/)
  await managePlugin('fixture', 'approve', { confirmHash: result.contentHash })
  assert.equal((await verifyManagedPlugin(f.target)).enabled, true)
  await writeFile(path.join(f.target, 'hooks', 'hook.mjs'), 'export default {name:"tampered"}')
  const plugins = await discoverLocalPluginManifests(f.root, { compat: {} })
  assert.equal(plugins.plugins.find(plugin => plugin.name === 'fixture').enabled, false)
  await assert.rejects(managePlugin('fixture', 'enable'), /不一致/)
})
test('portable top-level agent permission expansion needs new approval even with only Markdown', async t => {
  const f = await fixture(t, { agents: ['agents'], allowedAgentPermissions: ['default'] })
  await mkdir(path.join(f.source, 'agents')); await writeFile(path.join(f.source, 'agents', 'review.md'), 'Read-only review')
  const initial = await installPlugin({ name: 'fixture', source: f.source }); assert.equal(initial.pendingApproval, false)
  await writeFile(path.join(f.source, 'plugin.json'), JSON.stringify({ name: 'fixture', version: '1.0.1', agents: ['agents'], allowedAgentPermissions: ['full'] }))
  const updated = await managePlugin('fixture', 'update'); assert.equal(updated.pendingApproval, true)
  assert.ok(updated.addedCapabilities.some(item => item.startsWith('allowedAgentPermissions:')))
})
test('MCP JSON command or endpoint changes cannot reuse the previous package authorization', async t => {
  const f = await fixture(t, { mcp: ['mcp.json'] })
  await writeFile(path.join(f.source, 'mcp.json'), JSON.stringify({ servers: { fixture: { command: 'safe-command' } } }))
  const first = await installPlugin({ name: 'fixture', source: f.source }); assert.equal(first.pendingApproval, true)
  await managePlugin('fixture', 'approve', { confirmHash: first.contentHash })
  await writeFile(path.join(f.source, 'mcp.json'), JSON.stringify({ servers: { fixture: { command: 'different-command' } } }))
  assert.equal((await managePlugin('fixture', 'update')).pendingApproval, true)
})
test('nested agent permission aliases use exactly the loader precedence for install approval', async t => {
  const f = await fixture(t, { agents: ['agents'], allowedAgentPermissions: ['default'], capabilities: { allowedAgentPermissions: ['full'], allowed_agent_permissions: ['default'] } })
  await mkdir(path.join(f.source, 'agents')); await writeFile(path.join(f.source, 'agents', 'review.md'), 'Review')
  const result = await installPlugin({ name: 'fixture', source: f.source })
  assert.equal(result.pendingApproval, true)
  const loaded = (await discoverLocalPluginManifests(f.root, { compat: {} })).plugins.find(plugin => plugin.name === 'fixture')
  assert.deepEqual(loaded.capabilities.allowedAgentPermissions, ['full']); assert.equal(loaded.enabled, false)
  await writeFile(path.join(f.source, 'plugin.json'), JSON.stringify({ name: 'fixture', allowed_agent_permissions: ['default'], capabilities: { allowed_agent_permissions: 'full, default' } }))
  assert.equal((await inspectPluginContent(f.source)).requiresApproval, true)
})
test('initial install preserves an explicitly disabled portable manifest', async t => {
  const f = await fixture(t, { disabled: true })
  assert.equal((await installPlugin({ name: 'fixture', source: f.source })).enabled, false)
  assert.equal((await verifyManagedPlugin(f.target)).enabled, false)
})
test('package-local install metadata cannot redirect an update away from its private source pin', async t => {
  const f = await fixture(t)
  await installPlugin({ name: 'fixture', source: f.source })
  const evil = path.join(f.root, 'other'); await mkdir(evil); await writeFile(path.join(evil, 'plugin.json'), JSON.stringify({ name: 'fixture', version: '9.9.9' }))
  const marker = JSON.parse(await readFile(path.join(f.target, 'kkcode-install.json'), 'utf8')); marker.source = evil
  await writeFile(path.join(f.target, 'kkcode-install.json'), JSON.stringify(marker))
  await assert.rejects(verifyManagedPlugin(f.target), /来源/)
  assert.equal((await managePlugin('fixture', 'update')).version, '1.0.0', 'default update uses private lock, never package-local marker')
})
test('managed root aliases and hidden Git executable content are not outside integrity checks', async t => {
  const f = await fixture(t); await installPlugin({ name: 'fixture', source: f.source })
  await mkdir(path.join(f.target, '.git')); await writeFile(path.join(f.target, '.git', 'hook.mjs'), 'unlocked')
  await assert.rejects(inspectPluginContent(f.target), /Git/)
  if (process.platform !== 'win32') {
    const alias = path.join(f.root, 'alias'); await symlink(f.target, alias)
    await assert.rejects(inspectPluginContent(alias), /根目录/)
  }
})

test('local install pins a canonical source rather than resolving it in a future working directory', async t => {
  const f = await fixture(t)
  await installPlugin({ name: 'fixture', source: path.relative(process.cwd(), f.source) })
  const inspected = await managePlugin('fixture', 'inspect')
  assert.equal(inspected.lock.source, await import('node:fs/promises').then(fs => fs.realpath(f.source)))
  const originalRoot = (await verifyManagedPlugin(f.target)).loadRoot
  await writeFile(path.join(f.source, 'plugin.json'), JSON.stringify({ name: 'fixture', version: '1.0.1' }))
  await managePlugin('fixture', 'update')
  const nextRoot = (await verifyManagedPlugin(f.target)).loadRoot
  assert.notEqual(nextRoot, originalRoot)
  assert.equal(JSON.parse(await readFile(path.join(originalRoot, 'plugin.json'), 'utf8')).version, '1.0.0', 'old verified import paths are never replaced by an update')
})

test('disable does not follow a swapped managed root to write another directory', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await installPlugin({ name: 'fixture', source: f.source })
  await rename(f.target, `${f.target}-saved`)
  await symlink(f.source, f.target)
  const original = await readFile(path.join(f.source, 'plugin.json'))
  await assert.rejects(managePlugin('fixture', 'disable'), /symbolic link/)
  assert.deepEqual(await readFile(path.join(f.source, 'plugin.json')), original)
})
