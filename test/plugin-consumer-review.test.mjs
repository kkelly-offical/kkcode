import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink, symlink } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { installPlugin, managePlugin } from '../src/kernel/plugin/manager.mjs'
import { createToolRegistry } from '../src/kernel/tool/registry.mjs'
import { createSkillRegistry } from '../src/kernel/skill/registry.mjs'
import { createHookBus } from '../src/kernel/plugin/hook-bus.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)

test('managed dynamic ToolRegistry consumers cannot import pending code and approved relative imports use fixed content roots', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'kk-plugin-consumer-')), state = path.join(root, 'state'), source = path.join(root, 'source'), project = path.join(root, 'project'), marker = path.join(root, 'import-marker')
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = state
  const registries = []
  t.after(async () => { for (const registry of registries) await registry.shutdown(); if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  await mkdir(path.join(source, 'tools'), { recursive: true }); await mkdir(project)
  await writeFile(path.join(source, 'plugin.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', tools: ['tools'] }))
  await writeFile(path.join(source, 'tools', 'version.mjs'), 'export const value="v1";')
  await writeFile(path.join(source, 'tools', 'probe.mjs'), `import {writeFile} from 'node:fs/promises'; import {value} from './version.mjs'; await writeFile(${JSON.stringify(marker)},value+':'+import.meta.url); export default {name:'managed_probe',inputSchema:{type:'object'},execute:async()=>value};`)
  const installed = await installPlugin({ name: 'fixture', source })
  assert.equal(installed.pendingApproval, true)
  const config = { tool: { sources: { builtin: false, local: false, plugin: true, mcp: false }, plugin_dirs: [path.join(state, 'plugins', 'fixture', 'tools')] } }
  async function load() {
    const registry = createToolRegistry(); registries.push(registry)
    await registry.initialize({ cwd: project, config, force: true, allowProjectSources: false })
    return registry
  }
  const pending = await load()
  await assert.rejects(readFile(marker), { code: 'ENOENT' }, 'listing pending managed tools must not execute module top-level code')
  assert.equal(await pending.get('managed_probe'), null)
  await managePlugin('fixture', 'approve', { confirmHash: installed.contentHash })
  const first = await load(), original = await first.get('managed_probe')
  assert.equal(await original.execute({}, {}), 'v1')
  assert.match(await readFile(marker, 'utf8'), new RegExp(`plugin-content/${installed.contentHash}/tools/probe.mjs`))
  await unlink(marker)
  await writeFile(path.join(source, 'tools', 'version.mjs'), 'export const value="v2";')
  const update = await managePlugin('fixture', 'update')
  assert.equal(update.pendingApproval, true)
  const notApproved = await load()
  assert.equal(await notApproved.get('managed_probe'), null)
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
  await managePlugin('fixture', 'approve', { confirmHash: update.contentHash })
  const next = await load()
  assert.equal(await (await next.get('managed_probe')).execute({}, {}), 'v2')
  assert.equal(await original.execute({}, {}), 'v1', 'existing trusted import identity is not silently replaced by an update')
  assert.match(await readFile(marker, 'utf8'), new RegExp(`plugin-content/${update.contentHash}/tools/probe.mjs`))
  await managePlugin('fixture', 'disable')
  assert.equal(await (await load()).get('managed_probe'), null)
})

test('explicit Skill directories cannot expose pending managed packages outside the manifest consumer', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'kk-plugin-skill-consumer-')), source = path.join(root, 'source'), project = path.join(root, 'project'), state = path.join(root, 'state')
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = state
  t.after(async () => { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  await mkdir(path.join(source, 'skills'), { recursive: true }); await mkdir(project)
  await writeFile(path.join(source, 'plugin.json'), JSON.stringify({ name: 'fixture', skills: ['skills'] }))
  await writeFile(path.join(source, 'skills', 'probe.mjs'), 'export const name="managed-probe"; export async function run(){return "managed-code"}')
  const installed = await installPlugin({ name: 'fixture', source })
  assert.equal(installed.pendingApproval, true)
  const registry = createSkillRegistry()
  await registry.initialize({ skills: { auto_seed: false, dirs: [path.join(state, 'plugins', 'fixture', 'skills')] }, mcp: { auto_discover: false } }, project, { allowProjectSources: false })
  assert.equal(registry.get('managed-probe'), null, 'user-configured directory does not replace exact-content approval for a managed package')
})

test('aliases nested inside an unmanaged plugins directory still resolve the real managed ancestor', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'kk-plugin-nested-alias-')), source = path.join(root, 'source'), state = path.join(root, 'state')
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = state
  const registries = []
  t.after(async () => { for (const registry of registries) await registry.shutdown(); if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  await mkdir(path.join(source, 'tools'), { recursive: true })
  await writeFile(path.join(source, 'plugin.json'), JSON.stringify({ name: 'fixture', tools: ['tools'] }))
  await writeFile(path.join(source, 'tools', 'probe.mjs'), 'export default {name:"nested_probe",execute:async()=>"approved"}')
  const installed = await installPlugin({ name: 'fixture', source })
  const wrapper = path.join(state, 'plugins', 'LocalAuthor'), alias = path.join(wrapper, 'tools')
  await mkdir(wrapper); await symlink(path.join(state, 'plugins', 'fixture', 'tools'), alias, process.platform === 'win32' ? 'junction' : 'dir')
  const load = async dir => {
    const registry = createToolRegistry(); registries.push(registry)
    await registry.initialize({ cwd: root, config: { tool: { sources: { builtin: false, local: true, plugin: false, mcp: false }, local_dirs: [dir] } } })
    return registry
  }
  assert.equal(await (await load(alias)).get('nested_probe'), null)
  await managePlugin('fixture', 'approve', { confirmHash: installed.contentHash })
  assert.equal(await (await (await load(alias)).get('nested_probe')).execute({}, {}), 'approved')
  assert.equal(await (await load(path.join(state, 'plugin-content', installed.contentHash, 'tools'))).get('nested_probe'), null, 'raw cache path is not an activation API')
  await writeFile(path.join(wrapper, 'author.mjs'), 'export default {name:"author_probe",execute:async()=>"legacy"}')
  assert.equal(await (await (await load(wrapper)).get('author_probe')).execute({}, {}), 'legacy', 'never-managed author directories retain their explicit compatibility trust')
})

test('loose user hook aliases cannot import a pending managed package', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'kk-plugin-hook-consumer-')), source = path.join(root, 'source'), project = path.join(root, 'project'), state = path.join(root, 'state'), marker = path.join(root, 'hook-marker')
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = state
  t.after(async () => { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  await mkdir(path.join(source, 'hooks'), { recursive: true }); await mkdir(project)
  await writeFile(path.join(source, 'plugin.json'), JSON.stringify({ name: 'fixture', hooks: ['hooks'] }))
  await writeFile(path.join(source, 'hooks', 'probe.mjs'), `import {writeFile} from 'node:fs/promises'; await writeFile(${JSON.stringify(marker)},'hook executed'); export default {name:'managed-hook',chat:{params:x=>({...x,managedHook:true})}};`)
  const installed = await installPlugin({ name: 'fixture', source })
  assert.equal(installed.pendingApproval, true)
  await symlink(path.join(state, 'plugins', 'fixture', 'hooks'), path.join(state, 'hooks'), 'dir')
  const bus = createHookBus()
  await bus.initialize(project, {}, { allowProjectSources: false })
  await assert.rejects(readFile(marker), { code: 'ENOENT' }, 'loose alias must not bypass the managed package lock')
  assert.ok(!bus.list().some(hook => hook.name === 'managed-hook'))
  await managePlugin('fixture', 'approve', { confirmHash: installed.contentHash })
  await bus.initialize(project, {}, { allowProjectSources: false, force: true })
  assert.ok(bus.list().some(hook => hook.name === 'managed-hook' && hook.source.includes(installed.contentHash)))
})

test('plugin content identity is deterministic across process locale changes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'kk-plugin-locale-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, 'plugin.json'), '{"name":"fixture"}')
  await writeFile(path.join(root, 'ä.txt'), 'same contents'); await writeFile(path.join(root, 'z.txt'), 'same contents')
  const probe = `const {inspectPluginContent}=await import(process.argv[1]); console.log((await inspectPluginContent(process.argv[2])).contentHash)`
  const hashes = []
  for (const locale of ['de_DE.UTF-8', 'sv_SE.UTF-8']) {
    const result = await exec(process.execPath, ['--input-type=module', '-e', probe, new URL('../src/kernel/plugin/integrity.mjs', import.meta.url).href, root], { env: { ...process.env, LANG: locale, LC_ALL: locale }, timeout: 5000 })
    hashes.push(result.stdout.trim())
  }
  assert.equal(hashes[0], hashes[1], 'locale must not make an unchanged locked package appear tampered')
})

test('editing an unapproved Markdown upgrade cannot clear its exact-hash approval requirement', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'kk-plugin-pending-edit-')), source = path.join(root, 'source'), state = path.join(root, 'state')
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = state
  t.after(async () => { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  await mkdir(path.join(source, 'skills'), { recursive: true })
  await writeFile(path.join(source, 'plugin.json'), JSON.stringify({ name: 'fixture', skills: ['skills'] }))
  await writeFile(path.join(source, 'skills', 'old.md'), 'Existing prompt')
  assert.equal((await installPlugin({ name: 'fixture', source })).pendingApproval, false)
  await mkdir(path.join(source, 'extra')); await writeFile(path.join(source, 'extra', 'new.md'), 'New capability')
  await writeFile(path.join(source, 'plugin.json'), JSON.stringify({ name: 'fixture', skills: ['skills', 'extra'] }))
  assert.equal((await managePlugin('fixture', 'update')).pendingApproval, true)
  await writeFile(path.join(source, 'extra', 'new.md'), 'Edited while still unapproved')
  assert.equal((await managePlugin('fixture', 'update')).pendingApproval, true, 'pending approval must survive any subsequent unapproved content change')
  await assert.rejects(managePlugin('fixture', 'enable'), /批准/)
})

test('an unmanaged manifest does not mint verified-cache authority for a pending managed hook', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'kk-plugin-cache-alias-')), source = path.join(root, 'source'), state = path.join(root, 'state'), project = path.join(root, 'project'), marker = path.join(root, 'cache-marker')
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = state
  t.after(async () => { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  await mkdir(path.join(source, 'hooks'), { recursive: true })
  await writeFile(path.join(source, 'plugin.json'), JSON.stringify({ name: 'fixture', hooks: ['hooks'] }))
  await writeFile(path.join(source, 'hooks', 'probe.mjs'), `import {writeFile} from 'node:fs/promises'; await writeFile(${JSON.stringify(marker)},'cache bypass'); export default {name:'cache-hook'};`)
  const installed = await installPlugin({ name: 'fixture', source })
  const wrapper = path.join(project, '.kkcode', 'plugins', 'author-wrapper')
  await mkdir(wrapper, { recursive: true })
  await writeFile(path.join(wrapper, 'plugin.json'), JSON.stringify({ name: 'author-wrapper', hooks: ['alias'] }))
  await symlink(path.join(state, 'plugin-content', installed.contentHash, 'hooks'), path.join(wrapper, 'alias'), 'dir')
  const bus = createHookBus()
  await bus.initialize(project, {}, { allowProjectSources: true })
  await assert.rejects(readFile(marker), { code: 'ENOENT' }, 'author manifest must not act as a verified managed-manifest capability')
  assert.ok(!bus.list().some(hook => hook.name === 'cache-hook'))
})
