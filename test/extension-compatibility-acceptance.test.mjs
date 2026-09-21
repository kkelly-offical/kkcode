import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSkillRegistry } from '../src/kernel/skill/registry.mjs'
import { installPlugin, managePlugin } from '../src/kernel/plugin/manager.mjs'
import { discoverLocalPluginManifests } from '../src/kernel/plugin/manifest-loader.mjs'
import { discoverCompatSkillRoots } from '../src/compat/ecosystem-discovery.mjs'

const config = { skills: { auto_seed: false }, mcp: { auto_discover: false }, compat: { plugins: { ecosystems: ['kkcode'] } } }
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-extension-acceptance-')), previous = process.env.KKCODE_HOME
  const home = path.join(root, 'state'), project = path.join(root, 'project')
  await mkdir(home); await mkdir(project); process.env.KKCODE_HOME = home
  t.after(async () => { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  const put = async (file, content) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content) }
  return { root, home, project, put }
}

test('Agent Skills metadata discovery does not execute modules or inject full instruction bodies; activation resolves auxiliary files', async t => {
  const { home, project, put } = await fixture(t), root = path.join(project, '.agents', 'skills'), marker = path.join(home, 'invoked.json')
  await put(path.join(root, 'portable-review', 'SKILL.md'), `---\nname: portable-review\ndescription: Portable review acceptance fixture\nlicense: MIT\ncompatibility: Requires local Node.js\nmetadata:\n  author: fixture\n  version: "1"\nallowed-tools: Read Bash(git:*)\n---\nFULL_BODY_NOT_IN_INVENTORY\nArguments: $ARGUMENTS\n$FILE{guide.md}\n`)
  await put(path.join(root, 'portable-review', 'guide.md'), 'guide before activation')
  await put(path.join(root, 'programmable.mjs'), `import { writeFile } from 'node:fs/promises'\nawait writeFile(${JSON.stringify(marker)}, 'imported')\nexport const name = 'programmable-fixture'\nexport const description = 'Lazy programmable acceptance fixture'\nexport function run(ctx) { return 'approved invocation: ' + ctx.args }\n`)
  assert.ok((await discoverCompatSkillRoots(project, { compat: { plugins: { ecosystems: ['codex'] } } })).some(item => item.dir === root && item.scope === 'project'))
  const registry = createSkillRegistry(), options = { ...config, skills: { auto_seed: false, dirs: ['.agents/skills'] } }
  await registry.initialize(options, project)
  await assert.rejects(access(marker), { code: 'ENOENT' })
  const inventory = registry.listForSystemPrompt(), portable = registry.get('portable-review')
  assert.deepEqual(inventory.find(skill => skill.name === 'portable-review'), { name: 'portable-review', description: 'Portable review acceptance fixture' })
  assert.equal(JSON.stringify(inventory).includes('FULL_BODY_NOT_IN_INVENTORY'), false)
  assert.equal(JSON.stringify(inventory).includes('guide before activation'), false)
  assert.equal(portable.license, 'MIT')
  assert.deepEqual(portable.allowedTools, ['Read', 'Bash(git:*)'])
  assert.deepEqual(portable.metadata, { author: 'fixture', version: '1' })
  await put(path.join(root, 'portable-review', 'guide.md'), 'guide read at activation')
  const prompt = await registry.execute('portable-review', 'src/main.mjs', { cwd: project })
  assert.match(prompt, /FULL_BODY_NOT_IN_INVENTORY/)
  assert.match(prompt, /src\/main.mjs/)
  assert.match(prompt, /guide read at activation/)
  assert.equal(await registry.execute('programmable-fixture', 'confirmed', { cwd: project }), 'approved invocation: confirmed')
  assert.equal(await readFile(marker, 'utf8'), 'imported')
  await registry.initialize(options, project, { allowProjectSources: false })
  assert.equal(registry.get('portable-review'), null, 'untrusted project skills are excluded')
})

test('portable plugin install, discovery, invocation, disable/enable, update and recoverable removal form a real lifecycle', async t => {
  const { root, home, project, put } = await fixture(t), source = path.join(root, 'portable-source')
  const manifestPath = path.join(source, '.claude-plugin', 'plugin.json')
  await put(manifestPath, JSON.stringify({ name: 'upstream-portable', version: '1.0.0', description: 'Portable fixture' }))
  await put(path.join(source, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Managed portable review\n---\nInstalled portable body: $ARGUMENTS')
  await put(path.join(source, 'package.json'), JSON.stringify({ name: 'fixture-never-published', scripts: { install: 'node nonexistent-install-script.mjs' } }))
  assert.equal((await installPlugin({ name: 'portable', source })).installed, true)
  const registry = createSkillRegistry()
  await registry.initialize(config, project)
  assert.ok(registry.get('portable:review'), 'managed portable defaults survive normalized install layout')
  assert.equal(await registry.execute('portable:review', 'working', { cwd: project }), 'Installed portable body: working')
  await managePlugin('portable', 'disable'); await registry.initialize(config, project)
  assert.equal(registry.get('portable:review'), null)
  assert.equal((await discoverLocalPluginManifests(project, config)).plugins.find(plugin => plugin.name === 'portable').enabled, false)
  await managePlugin('portable', 'enable'); await registry.initialize(config, project)
  assert.ok(registry.get('portable:review'))
  await put(manifestPath, JSON.stringify({ name: 'upstream-portable', version: '1.0.1' }))
  await put(path.join(source, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Updated portable review\n---\nUpdated body')
  await managePlugin('portable', 'disable')
  assert.equal((await managePlugin('portable', 'update')).version, '1.0.1')
  await registry.initialize(config, project)
  assert.equal(registry.get('portable:review'), null, 'update never silently re-enables a disabled plugin')
  await managePlugin('portable', 'enable'); await registry.initialize(config, project)
  assert.equal(await registry.execute('portable:review', '', { cwd: project }), 'Updated body')
  await put(manifestPath, '{invalid')
  await assert.rejects(managePlugin('portable', 'update'), /manifest/)
  assert.equal(JSON.parse(await readFile(path.join(home, 'plugins', 'portable', 'plugin.json'), 'utf8')).version, '1.0.1', 'failed update keeps working installed version')
  assert.deepEqual(await managePlugin('portable', 'remove'), { name: 'portable', removed: true, recoverable: true })
  await registry.initialize(config, project)
  assert.equal(registry.get('portable:review'), null)
  assert.equal((await readdir(path.join(home, 'plugin-trash'))).length, 1)
})

test('managed plugin sources reject unpinned remote installs and local symlinks before activation', async t => {
  const { root, put } = await fixture(t), source = path.join(root, 'unsafe-source')
  await assert.rejects(installPlugin({ name: 'fixture', source: 'npm:fixture@latest' }), /exact version/)
  await assert.rejects(installPlugin({ name: 'fixture', source: 'https://example.invalid/fixture.git', revision: 'main' }), /full commit SHA/)
  await assert.rejects(installPlugin({ name: '../escape', source }), /Plugin name/)
  if (process.platform !== 'win32') {
    await put(path.join(source, 'plugin.json'), '{"name":"fixture"}')
    await put(path.join(root, 'outside.txt'), 'outside plugin')
    await symlink(path.join(root, 'outside.txt'), path.join(source, 'linked.txt'))
    await assert.rejects(installPlugin({ name: 'fixture', source }), /symbolic links/)
  }
})
