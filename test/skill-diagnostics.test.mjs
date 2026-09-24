import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSkillRegistry } from '../src/kernel/skill/registry.mjs'

test('Skill unsupported fields are explicit; malformed security metadata never silently drops restrictions', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'kk-skill-diagnostics-')), old = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'home')
  t.after(async () => { if (old === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = old; await rm(root, { recursive: true, force: true }) })
  const skills = path.join(root, 'project', '.kkcode', 'skills')
  await mkdir(skills, { recursive: true })
  const files = {
    partial: '---\nname: partial\nagent: reviewer\neffort: high\nshell: bash\nhooks: {}\npaths: [src/**]\nfuture-capability: true\nallowed-tools: read grep\n---\nbody',
    broken: '---\nname: broken\nallowed-tools: [read\n---\nmust not run',
    quoted: '---\nname: quoted\nuser-invocable: "false"\n---\nmust not run',
    restriction: '---\nname: restriction\nallowed-tools: {read: true}\n---\nmust not run',
    unterminated: '---\nname: unterminated\nallowed-tools: read\nmust not run'
  }
  for (const [name, contents] of Object.entries(files)) await writeFile(path.join(skills, `${name}.md`), contents)
  await mkdir(path.join(skills, 'bom'))
  await writeFile(path.join(skills, 'bom', 'SKILL.md'), '\uFEFF---\nname: bom\ndisable-model-invocation: true\nallowed-tools: read\n---\nWindows-authored skill')
  const registry = createSkillRegistry()
  await registry.initialize({ skills: { auto_seed: false }, mcp: { auto_discover: false } }, path.join(root, 'project'))
  assert.deepEqual(registry.get('partial').allowedTools, ['read', 'grep'])
  assert.equal(registry.get('bom').disableModelInvocation, true)
  assert.deepEqual(registry.get('bom').allowedTools, ['read'])
  const diagnostics = registry.diagnostics()
  for (const field of ['agent', 'effort', 'shell', 'hooks', 'paths', 'future-capability']) assert.ok(diagnostics.some(item => item.name === 'partial' && item.field === field && item.kind === 'skill_unsupported_field'))
  for (const name of ['broken', 'quoted', 'restriction', 'unterminated']) {
    assert.equal(registry.get(name), null)
    assert.ok(diagnostics.some(item => item.name === name && item.kind === 'skill_invalid_frontmatter'))
  }
})
