import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { changeDeviceBranch, listDeviceBranches } from '../src/device/branches.mjs'

const execute = promisify(execFile)
const git = async (cwd, ...args) => (await execute('git', args, { cwd, windowsHide: true })).stdout.trimEnd()
async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-branches-')), cwd = path.join(root, 'repo')
  await mkdir(cwd); t.after(() => rm(root, { recursive: true, force: true }))
  await git(cwd, 'init', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'KK Code Test'); await git(cwd, 'config', 'user.email', 'test@example.invalid')
  await writeFile(path.join(cwd, 'data.txt'), 'preserved\n')
  await git(cwd, 'add', 'data.txt'); await git(cwd, '-c', 'commit.gpgsign=false', 'commit', '-m', 'initial')
  return { cwd, roots: [root], root }
}
async function change(options, extra) {
  const snapshot = await listDeviceBranches(options.cwd, options.roots)
  return changeDeviceBranch({ ...options, confirmed: true, stateToken: snapshot.stateToken, ...extra })
}

test('local branches list/create/switch safely, preserving commit content and explicit snapshots', async t => {
  const options = await repository(t), initial = await listDeviceBranches(options.cwd, options.roots)
  assert.equal(initial.current, 'main'); assert.equal(initial.clean, true)
  assert.equal(initial.branches[0].current, true)
  const created = await change(options, { name: 'feature/safe', create: true })
  assert.equal(created.current, 'feature/safe')
  assert.equal(created.head, initial.head)
  const switched = await change(options, { name: 'main' })
  assert.equal(switched.current, 'main')
  assert.equal(await readFile(path.join(options.cwd, 'data.txt'), 'utf8'), 'preserved\n')
  assert.deepEqual(await change(options, { name: 'main' }), switched)
})

test('confirmation, invalid refs, nonexistent branches, stale snapshots and active turns are rejected', async t => {
  const options = await repository(t), state = await listDeviceBranches(options.cwd, options.roots)
  await assert.rejects(changeDeviceBranch({ ...options, name: 'main', stateToken: state.stateToken }), { code: 'confirmation_required' })
  for (const name of ['-f', '--detach', '../outside', 'refs/heads/x', 'HEAD', '@{-1}', 'bad branch', 'bad\nbranch', 'bad..branch', 'branch:evil']) {
    await assert.rejects(change(options, { name, create: true }), { code: 'invalid_branch' })
  }
  await assert.rejects(change(options, { name: 'missing' }), { code: 'branch_missing' })
  await assert.rejects(change(options, { name: 'main', create: true }), { code: 'branch_exists' })
  await assert.rejects(change(options, { name: 'new', create: true, stateToken: 'stale' }), { code: 'branch_state_changed' })
  await assert.rejects(change(options, { name: 'new', create: true, assertIdle: () => { throw new Error('turn_busy') } }), /turn_busy/)
  await assert.rejects(change(options, { cwd: os.tmpdir(), name: 'outside', create: true }), { code: 'path_denied' })
  assert.equal(await git(options.cwd, 'branch', '--show-current'), 'main')
})

test('dirty tracked, staged and untracked files are never discarded or carried into another branch', async t => {
  const options = await repository(t), file = path.join(options.cwd, 'data.txt')
  await git(options.cwd, 'branch', 'other')
  await writeFile(file, 'uncommitted\n')
  await assert.rejects(change(options, { name: 'other' }), { code: 'worktree_dirty' })
  await git(options.cwd, 'add', 'data.txt')
  await assert.rejects(change(options, { name: 'other' }), { code: 'worktree_dirty' })
  assert.equal(await readFile(file, 'utf8'), 'uncommitted\n')
  await git(options.cwd, '-c', 'commit.gpgsign=false', 'commit', '-m', 'preserve edits')
  await writeFile(path.join(options.cwd, 'new.txt'), 'untracked')
  await assert.rejects(change(options, { name: 'other' }), { code: 'worktree_dirty' })
  assert.equal(await readFile(path.join(options.cwd, 'new.txt'), 'utf8'), 'untracked')
})

test('branches checked out elsewhere, pending Git operations and credential roots are protected', async t => {
  const options = await repository(t), other = path.join(options.root, 'worktree')
  await git(options.cwd, 'worktree', 'add', '-b', 'occupied', other)
  const state = await listDeviceBranches(options.cwd, options.roots)
  assert.equal(state.branches.find(branch => branch.name === 'occupied').checkedOut, true)
  await assert.rejects(change(options, { name: 'occupied' }), { code: 'branch_in_use' })
  await writeFile(path.join(options.cwd, '.git', 'MERGE_HEAD'), state.head)
  await assert.rejects(change(options, { name: 'new', create: true }), { code: 'worktree_dirty' })
  const privateDir = path.join(options.root, '.ssh'); await mkdir(privateDir)
  await assert.rejects(listDeviceBranches(privateDir, options.roots), { code: 'path_denied' })
})

test('branch mutation never invokes repository hooks or checkout filters', async t => {
  const options = await repository(t), hookMarker = path.join(options.root, 'hook-ran'), filterMarker = path.join(options.root, 'filter-ran')
  await git(options.cwd, 'branch', 'other')
  await writeFile(path.join(options.cwd, '.gitattributes'), 'data.txt filter=unsafe\n')
  await writeFile(path.join(options.cwd, 'data.txt'), 'changed committed content\n')
  await git(options.cwd, 'add', '.gitattributes', 'data.txt'); await git(options.cwd, '-c', 'commit.gpgsign=false', 'commit', '-m', 'attributes')
  await writeFile(path.join(options.cwd, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\nprintf invoked > '${hookMarker.replaceAll("'", "'\\''")}'\n`, { mode: 0o755 })
  await git(options.cwd, 'config', 'filter.unsafe.smudge', `sh -c "echo invoked > '${filterMarker}'; cat"`)
  await git(options.cwd, 'config', 'filter.unsafe.clean', `sh -c "echo invoked > '${filterMarker}'; cat"`)
  await git(options.cwd, 'config', 'filter.unsafe.required', 'true')
  await change(options, { name: 'other' })
  await change(options, { name: 'main' })
  await assert.rejects(access(hookMarker))
  await assert.rejects(access(filterMarker))
  assert.equal(await readFile(path.join(options.cwd, 'data.txt'), 'utf8'), 'changed committed content\n')
})

test('parallel mutations from one snapshot cannot both proceed', async t => {
  const options = await repository(t), state = await listDeviceBranches(options.cwd, options.roots)
  const results = await Promise.allSettled(['one', 'two'].map(name => changeDeviceBranch({ ...options, name, create: true, confirmed: true, stateToken: state.stateToken })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'branch_state_changed')
})

test('submodules are inspected without their filters; dirty children and revision changes require local handling', async t => {
  const options = await repository(t), seed = path.join(options.root, 'module-seed')
  await mkdir(seed); await git(seed, 'init', '-b', 'main')
  await git(seed, 'config', 'user.name', 'KK Code Test'); await git(seed, 'config', 'user.email', 'test@example.invalid')
  await writeFile(path.join(seed, 'child.txt'), 'child content\n')
  await writeFile(path.join(seed, '.gitattributes'), 'child.txt filter=unsafe\n')
  await git(seed, 'add', '.'); await git(seed, '-c', 'commit.gpgsign=false', 'commit', '-m', 'child')
  await git(options.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'add', seed, 'modules/dep')
  await git(options.cwd, '-c', 'commit.gpgsign=false', 'commit', '-am', 'submodule')
  await git(options.cwd, 'branch', 'no-module', 'HEAD~1')
  const child = path.join(options.cwd, 'modules', 'dep'), marker = path.join(options.root, 'child-filter-ran')
  await git(child, 'config', 'filter.unsafe.clean', `sh -c "echo invoked > '${marker}'; cat"`)
  assert.equal((await change(options, { name: 'compatible', create: true })).current, 'compatible')
  await assert.rejects(change(options, { name: 'no-module' }), { code: 'submodule_change' })
  await writeFile(path.join(child, 'child.txt'), 'unsaved child work\n')
  assert.equal((await listDeviceBranches(options.cwd, options.roots)).clean, false)
  await assert.rejects(change(options, { name: 'main' }), { code: 'worktree_dirty' })
  await assert.rejects(access(marker))
  assert.equal(await readFile(path.join(child, 'child.txt'), 'utf8'), 'unsaved child work\n')
})
