import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile, access, realpath, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { changeDeviceBranch, listDeviceBranches, sameGitDirectory, createDeviceWorktree } from '../src/device/branches.mjs'
import { DeviceService } from '../src/device/service.mjs'

const execute = promisify(execFile)
const git = async (cwd, ...args) => (await execute('git', args, { cwd, windowsHide: true })).stdout.trimEnd()
async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-branches-')), cwd = path.join(root, 'repo')
  await mkdir(cwd); t.after(() => rm(root, { recursive: true, force: true }))
  await git(cwd, 'init', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'KK Code Test'); await git(cwd, 'config', 'user.email', 'test@example.invalid')
  await git(cwd, 'config', 'core.autocrlf', 'false')
  await writeFile(path.join(cwd, 'data.txt'), 'preserved\n')
  await git(cwd, 'add', 'data.txt'); await git(cwd, '-c', 'commit.gpgsign=false', 'commit', '-m', 'initial')
  return { cwd, roots: [root], root }
}
async function change(options, extra) {
  const snapshot = await listDeviceBranches(options.cwd, options.roots)
  return changeDeviceBranch({ ...options, confirmed: true, stateToken: snapshot.stateToken, ...extra })
}

test('detailed branch catalog includes cached remote refs and safe worktree creation preserves dirty source files', async t => {
  const options = await repository(t)
  await git(options.cwd, 'remote', 'add', 'origin', 'https://example.invalid/repo.git')
  const head = await git(options.cwd, 'rev-parse', 'HEAD')
  await git(options.cwd, 'update-ref', 'refs/remotes/origin/main', head)
  await git(options.cwd, 'branch', '--set-upstream-to=origin/main', 'main')
  await writeFile(path.join(options.cwd, 'data.txt'), 'uncommitted stays here\n')
  const before = await listDeviceBranches(options.cwd, options.roots)
  assert.equal(before.branches[0].upstream, 'origin/main')
  assert.equal(before.branches[0].subject, 'initial'); assert.ok(before.branches[0].lastCommitAt)
  assert.equal(before.remoteBranches[0].name, 'origin/main')
  const result = await createDeviceWorktree({ ...options, name: 'feature/worktree', parent: options.root, folderName: '工作树 two', startPoint: 'origin/main', confirmed: true, stateToken: before.stateToken })
  assert.equal(result.sourceFilesChanged, false); assert.equal(result.current, 'main')
  assert.equal(await readFile(path.join(options.cwd, 'data.txt'), 'utf8'), 'uncommitted stays here\n')
  assert.equal(await readFile(path.join(result.created.path, 'data.txt'), 'utf8'), 'preserved\n')
  assert.equal(await git(result.created.path, 'branch', '--show-current'), 'feature/worktree')
  assert.ok(result.worktrees.some(item => item.path === result.created.path && item.branch === 'feature/worktree'))
})

test('worktree creation refuses existing/private paths, stale confirmations and invalid start points without overwriting anything', async t => {
  const options = await repository(t), before = await listDeviceBranches(options.cwd, options.roots)
  const input = { ...options, name: 'feature/worktree', parent: options.root, folderName: 'new-tree', confirmed: true, stateToken: before.stateToken }
  for (const folderName of ['..', '../escape', '.ssh', '.kkcode', 'NUL']) await assert.rejects(createDeviceWorktree({ ...input, folderName }))
  await assert.rejects(createDeviceWorktree({ ...input, folderName: 'repo' }), { code: 'path_exists' })
  await assert.rejects(createDeviceWorktree({ ...input, stateToken: 'stale' }), { code: 'branch_state_changed' })
  await assert.rejects(createDeviceWorktree({ ...input, startPoint: 'HEAD~1' }), { code: 'invalid_start_point' })
  await assert.rejects(createDeviceWorktree({ ...input, confirmed: false }), { code: 'confirmation_required' })
  assert.equal((await listDeviceBranches(options.cwd, options.roots)).worktrees.length, 1)
  assert.equal(await readFile(path.join(options.cwd, 'data.txt'), 'utf8'), 'preserved\n')
})

test('worktree checkout disables hooks and filters and opening one creates a separate session', async t => {
  const options = await repository(t), marker = path.join(options.root, 'hook-ran')
  await writeFile(path.join(options.cwd, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\nprintf x > '${marker.replaceAll("'", "'\\''")}'\n`, { mode: 0o755 })
  const before = await listDeviceBranches(options.cwd, options.roots)
  const added = await createDeviceWorktree({ ...options, name: 'feature/separate', parent: options.root, folderName: 'separate', confirmed: true, stateToken: before.stateToken })
  await assert.rejects(access(marker))
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = path.join(options.root, 'private')
  const service = await new DeviceService(options).initialize(), principal = { id: 'local', client: 'test' }
  try {
    const original = await service.dispatch('sessions.create', { cwd: options.cwd, title: 'Keep this session' }, principal)
    const snapshot = await service.dispatch('worktrees.list', { sessionId: original.id }, principal)
    const opened = await service.dispatch('worktrees.open', { sessionId: original.id, path: added.created.path, stateToken: snapshot.stateToken, confirmed: true }, principal)
    assert.notEqual(opened.sessionId, original.id); assert.equal(opened.cwd, added.created.path)
    assert.equal((await service.dispatch('sessions.get', { sessionId: original.id }, principal)).cwd, await realpath(options.cwd))
    await assert.rejects(service.dispatch('worktrees.open', { sessionId: original.id, path: options.root, stateToken: snapshot.stateToken, confirmed: true }, principal), { code: 'worktree_missing' })
  } finally { await service.close(); if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous }
})

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
  await git(seed, 'config', 'core.autocrlf', 'false')
  await writeFile(path.join(seed, 'child.txt'), 'child content\n')
  await writeFile(path.join(seed, '.gitattributes'), '* text eol=lf\nchild.txt filter=unsafe\n')
  await git(seed, 'add', '.'); await git(seed, '-c', 'commit.gpgsign=false', 'commit', '-m', 'child')
  await git(options.cwd, '-c', 'core.autocrlf=false', '-c', 'protocol.file.allow=always', 'submodule', 'add', seed, 'modules/dep')
  await git(options.cwd, '-c', 'commit.gpgsign=false', 'commit', '-am', 'submodule')
  await git(options.cwd, 'branch', 'no-module', 'HEAD~1')
  const child = path.join(options.cwd, 'modules', 'dep'), marker = path.join(options.root, 'child-filter-ran')
  await git(child, 'config', 'core.autocrlf', 'false')
  await git(child, 'config', 'filter.unsafe.clean', `sh -c "echo invoked > '${marker}'; cat"`)
  const created = await change(options, { name: 'compatible', create: true })
  assert.equal(created.current, 'compatible')
  assert.equal(created.submodules[0].initialized, true)
  assert.equal(created.submodules[0].clean, true)
  await assert.rejects(change(options, { name: 'no-module' }), { code: 'submodule_change' })
  await writeFile(path.join(child, 'child.txt'), 'unsaved child work\n')
  assert.equal((await listDeviceBranches(options.cwd, options.roots)).clean, false)
  await assert.rejects(change(options, { name: 'main' }), { code: 'worktree_dirty' })
  await assert.rejects(access(marker))
  assert.equal(await readFile(path.join(child, 'child.txt'), 'utf8'), 'unsaved child work\n')
})

test('Git directory identity normalizes Windows separators and recognizes case/8.3 aliases without conflating other directories', async () => {
  const long = 'C:\\Users\\RunnerAdmin\\AppData\\Local\\Temp\\repo\\modules\\dep'
  const short = 'C:/Users/RUNNER~1/AppData/Local/Temp/repo/modules/dep\r\n'
  const received = []
  const options = {
    pathApi: path.win32,
    realpathImpl: async value => { received.push(value); return value },
    statImpl: async value => ({ isDirectory: () => true, dev: 3n, ino: value.endsWith('\\other') ? 102n : 101n })
  }
  assert.equal(await sameGitDirectory(short, long, options), true)
  assert.ok(received.every(value => !value.includes('/') && !value.includes('\n') && !value.includes('\r')))
  assert.equal(await sameGitDirectory('c:/users/runneradmin/AppData/Local/Temp/repo/modules/dep\n', long, options), true)
  assert.equal(await sameGitDirectory('C:/Users/RunnerAdmin/AppData/Local/Temp/repo/modules/other\n', long, options), false)
  await assert.rejects(sameGitDirectory('relative/path\n', long, options), { code: 'unsafe_git_path' })
  assert.equal(await sameGitDirectory(short, long, { ...options, statImpl: async () => ({ isDirectory: () => true, dev: 3n, ino: 0n }) }), false)
})

test('Git directory comparison resolves real filesystem aliases and rejects sibling directories', async t => {
  const options = await repository(t), alias = path.join(options.root, 'repository-alias')
  await symlink(options.cwd, alias, 'junction')
  assert.equal(await sameGitDirectory(`${alias}\r\n`, await realpath(options.cwd)), true)
  assert.equal(await sameGitDirectory(`${options.root}\n`, options.cwd), false)
})

test('safe branch checkout respects repository CRLF settings instead of forcing the test fixture line endings', async t => {
  const options = await repository(t)
  await git(options.cwd, 'branch', 'other')
  await writeFile(path.join(options.cwd, 'data.txt'), 'second committed content\n')
  await git(options.cwd, 'add', 'data.txt'); await git(options.cwd, '-c', 'commit.gpgsign=false', 'commit', '-m', 'second version')
  await git(options.cwd, 'config', 'core.autocrlf', 'true')
  assert.equal((await change(options, { name: 'other' })).clean, true)
  assert.equal(await readFile(path.join(options.cwd, 'data.txt'), 'utf8'), 'preserved\r\n')
  assert.equal((await change(options, { name: 'main' })).clean, true)
  assert.equal(await readFile(path.join(options.cwd, 'data.txt'), 'utf8'), 'second committed content\r\n')
})
