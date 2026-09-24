import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createTaskWorkspace, taskWorkspaceBaseline } from '../src/kernel/isolation/task-workspace.mjs'
const exec = promisify(execFile)
async function repo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-task-workspace-')), cwd = path.join(root, 'repo')
  await mkdir(cwd)
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args) => exec('git', args, { cwd })
  await git('init'); await git('config', 'user.name', 'fixture'); await git('config', 'user.email', 'fixture@example.invalid')
  await writeFile(path.join(cwd, 'source.txt'), 'committed\n')
  await git('add', '.'); await git('commit', '-m', 'fixture')
  return { root, cwd, git }
}
test('task workspace starts from a fixed commit and never runs checkout hooks or smudge filters', async t => {
  const { root, cwd, git } = await repo(t)
  await writeFile(path.join(cwd, '.gitattributes'), '*.txt filter=unsafe\n')
  await git('add', '.gitattributes'); await git('commit', '-m', 'attributes')
  const marker = path.join(root, 'MUST_NOT_RUN')
  const script = path.join(root, 'unsafe.mjs'); await writeFile(script, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'bad');`)
  await git('config', 'filter.unsafe.smudge', `"${process.execPath}" "${script}"`)
  await git('config', 'filter.unsafe.required', 'true')
  await writeFile(path.join(cwd, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\n"${process.execPath}" "${script}"\n`, { mode: 0o700 })
  await writeFile(path.join(cwd, 'source.txt'), 'dirty user work\n')
  const before = await readFile(path.join(cwd, '.git', 'index'))
  const baseline = await taskWorkspaceBaseline(cwd)
  const work = await createTaskWorkspace({ cwd, expectedCommit: baseline.commit, parent: path.join(root, 'tasks') })
  assert.equal(await readFile(path.join(work.cwd, 'source.txt'), 'utf8'), 'committed\n')
  assert.equal(await readFile(path.join(cwd, 'source.txt'), 'utf8'), 'dirty user work\n')
  assert.deepEqual(await readFile(path.join(cwd, '.git', 'index')), before)
  await assert.rejects(access(marker), { code: 'ENOENT' })
  assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: work.cwd })).stdout.trim(), baseline.commit)
  assert.notEqual((await exec('git', ['rev-parse', '--absolute-git-dir'], { cwd: work.cwd })).stdout.trim(), path.join(cwd, '.git'))
})
test('task workspace rejects stale baselines and bounded snapshots before model work', async t => {
  const { root, cwd, git } = await repo(t)
  const baseline = await taskWorkspaceBaseline(cwd)
  await writeFile(path.join(cwd, 'next.txt'), 'next'); await git('add', '.'); await git('commit', '-m', 'next')
  await assert.rejects(createTaskWorkspace({ cwd, expectedCommit: baseline.commit, parent: path.join(root, 'tasks') }), { code: 'task_workspace_invalid' })
  const current = await taskWorkspaceBaseline(cwd)
  await assert.rejects(createTaskWorkspace({ cwd, expectedCommit: current.commit, parent: path.join(root, 'tasks'), maxBytes: 1 }), { code: 'task_workspace_invalid' })
  await assert.rejects(access(path.join(root, 'tasks')), { code: 'ENOENT' })
})
