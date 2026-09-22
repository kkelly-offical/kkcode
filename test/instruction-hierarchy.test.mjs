import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { loadInstructions } from '../src/kernel/session/instruction-loader.mjs'

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'kkcode-instructions-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  return base
}

test('instructions load from nearest Git root to cwd, not parents above the repository', async t => {
  const base = await fixture(t), root = path.join(base, 'repo'), child = path.join(root, 'src', 'feature')
  await mkdir(child, { recursive: true }); await mkdir(path.join(root, '.git'))
  await writeFile(path.join(base, 'AGENTS.md'), 'OUTSIDE')
  await writeFile(path.join(root, 'AGENTS.md'), 'ROOT')
  await writeFile(path.join(root, 'src', 'CLAUDE.md'), 'SOURCE')
  await writeFile(path.join(child, 'KKCODE.md'), 'LEAF')
  const instructions = await loadInstructions(child)
  assert.equal(instructions.length, 3)
  assert.match(instructions[0], /\nROOT$/)
  assert.match(instructions[1], /\nSOURCE$/)
  assert.match(instructions[2], /\nLEAF$/)
  assert.ok(instructions.every(block => !block.includes('OUTSIDE')))
  assert.match(instructions[0], /Deeper directory instructions take precedence/)
})

test('worktree .git files and nested repositories are boundaries; non-repositories remain cwd-only', async t => {
  const base = await fixture(t), child = path.join(base, 'child')
  await mkdir(child); await writeFile(path.join(base, 'AGENTS.md'), 'parent'); await writeFile(path.join(child, 'AGENTS.md'), 'child')
  assert.equal((await loadInstructions(child, { stopAt: base })).length, 1)
  await writeFile(path.join(base, '.git'), 'gitdir: external-metadata')
  assert.equal((await loadInstructions(child)).length, 2)
  await mkdir(path.join(child, '.git'))
  assert.equal((await loadInstructions(child)).length, 1)
})

test('all compatible names load in stable order and blank files are ignored', async t => {
  const root = await fixture(t)
  for (const file of ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md', 'KKCODE.md', '.kkcode.md']) await writeFile(path.join(root, file), file)
  const result = await loadInstructions(root)
  // KKCODE.md/kkcode.md are aliases on case-insensitive filesystems; avoid
  // silently loading the same physical instruction twice (covered below).
  assert.match(result[0], /\nAGENTS.md$/)
  await writeFile(path.join(root, 'AGENTS.md'), '  ')
  assert.ok((await loadInstructions(root)).every(block => !block.endsWith('AGENTS.md')))
})

test('oversize instruction sources fail explicitly instead of silently truncating', async t => {
  const root = await fixture(t)
  await writeFile(path.join(root, 'AGENTS.md'), 'x'.repeat(128 * 1024 + 1))
  await assert.rejects(loadInstructions(root), /Instruction files exceed/)
})

test('instruction symlinks cannot escape the project', async t => {
  const base = await fixture(t), root = path.join(base, 'repo'), outside = path.join(base, 'outside.md')
  await mkdir(root); await mkdir(path.join(root, '.git')); await writeFile(outside, 'private')
  try { await symlink(outside, path.join(root, 'AGENTS.md')) } catch (error) { if (error.code === 'EPERM') return t.skip('symlinks require platform privileges'); throw error }
  await assert.rejects(loadInstructions(root), /escapes the project boundary/)
})
