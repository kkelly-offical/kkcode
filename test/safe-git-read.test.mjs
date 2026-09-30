import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { readonlyGitArgs, safeGitReadInvocation } from '../src/kernel/permission/safe-git-read.mjs'
import { prepareControlledGitInvocation } from '../src/util/controlled-git.mjs'
import { getGitInfo, getDiff, getStagedDiff } from '../src/util/git.mjs'
import { createToolRegistry } from '../src/kernel/tool/registry.mjs'

const gitAvailable = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
const rgAvailable = spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0

async function fixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'kk-safe-git-read-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'core.autocrlf', 'false')
  await writeFile(path.join(cwd, 'input.txt'), 'before\n')
  git('add', 'input.txt'); git('commit', '-m', 'fixture')
  return { cwd, git }
}

test('read-only Git adapter selects only classified safe invocations', () => {
  assert.deepEqual(readonlyGitArgs('git status --short'), ['status', '--short'])
  assert.deepEqual(readonlyGitArgs('git diff HEAD -- input.txt'), ['diff', 'HEAD', '--', 'input.txt'])
  for (const command of ['cat input.txt', 'git diff --ext-diff', 'git log --textconv', 'git diff --out=result', 'git status; echo done', 'git diff *', 'git -c core.fsmonitor=program status', 'git branch new-name']) assert.equal(readonlyGitArgs(command), null, command)
  assert.equal(readonlyGitArgs('git status', { env: { PATH: 'override' } }), null)
})

test('prepared read-only Git uses fixed argv and an isolated host environment', { skip: !gitAvailable }, async t => {
  const { cwd } = await fixture(t)
  for (const subcommand of ['status', 'diff', 'show', 'log']) {
    const invocation = await safeGitReadInvocation(`git ${subcommand}`, {}, { cwd })
    assert.ok(path.isAbsolute(invocation.command))
    assert.ok(invocation.args.includes('--no-pager'))
    assert.ok(invocation.args.includes('--no-optional-locks'))
    for (const setting of ['core.fsmonitor=false', 'core.untrackedCache=false', 'submodule.recurse=false', 'diff.external=']) assert.ok(invocation.args.includes(setting), setting)
    assert.equal(invocation.env.GIT_OPTIONAL_LOCKS, '0')
    assert.equal(invocation.env.GIT_PAGER, '')
    assert.equal(invocation.env.PAGER, '')
    assert.equal(invocation.env.GIT_CONFIG_COUNT, undefined)
    assert.equal(invocation.env.GIT_EXTERNAL_DIFF, undefined)
    assert.equal(invocation.env.NODE_OPTIONS, undefined)
    if (subcommand !== 'status') {
      assert.ok(invocation.args.includes('--no-ext-diff'))
      assert.ok(invocation.args.includes('--no-textconv'))
    }
  }
  await assert.rejects(prepareControlledGitInvocation(['branch', '-D', 'main'], { cwd }), /inspection only/)
  await assert.rejects(prepareControlledGitInvocation(['remote', 'add', 'name', 'url'], { cwd }), /inspection only/)
  await assert.rejects(prepareControlledGitInvocation(['diff', '--ext-diff'], { cwd }), /cannot enable/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(safeGitReadInvocation('git status', {}, { cwd, signal: controller.signal }), { name: 'AbortError' })
})

test('ordinary prepared and native Git inspections stay functional without changing the index', { skip: !gitAvailable }, async t => {
  const { cwd } = await fixture(t)
  await writeFile(path.join(cwd, 'input.txt'), 'after\n')
  const index = await readFile(path.join(cwd, '.git', 'index'))
  const invocation = await safeGitReadInvocation('git diff', {}, { cwd })
  const output = execFileSync(invocation.command, invocation.args, { cwd, env: invocation.env, encoding: 'utf8' })
  assert.match(output, /\+after/)
  const info = await getGitInfo(cwd)
  assert.equal(info.ok, true, info.error)
  assert.equal(info.info.hasUncommittedChanges, true)
  assert.match((await getDiff(cwd)).diff, /\+after/)
  assert.equal((await getStagedDiff(cwd)).ok, true)
  assert.deepEqual(await readFile(path.join(cwd, '.git', 'index')), index)
  assert.equal((await getDiff(cwd, '--output=forbidden')).ok, false)
})

test('native grep treats option-like patterns as literal data and keeps ordinary search working', { skip: !rgAvailable }, async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'kk-literal-grep-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(path.join(cwd, 'input.txt'), 'needle\n--pre=literal-data\n')
  const registry = createToolRegistry()
  t.after(() => registry.shutdown())
  await registry.initialize({ cwd, config: { tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } } } })
  const grep = await registry.get('grep')
  const context = { cwd }
  assert.match(await grep.execute({ pattern: '--pre=literal-data', path: 'input.txt', output_mode: 'content' }, context), /--pre=literal-data/)
  assert.match(await grep.execute({ pattern: 'needle', path: 'input.txt', output_mode: 'content' }, context), /needle/)
})
