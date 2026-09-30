import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import { createToolRegistry } from '../src/kernel/tool/registry.mjs'
import { BackgroundManager } from '../src/kernel/orchestration/background-manager.mjs'
import { probeBwrap } from '../src/kernel/tool/sandbox.mjs'

const exec = promisify(execFile)
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-bash-git-')), cwd = path.join(root, 'repository')
  await mkdir(cwd)
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = path.join(root, 'state')
  const registry = createToolRegistry(), ids = []
  t.after(async () => {
    for (const id of ids) { await BackgroundManager.cancel(id); await BackgroundManager.waitForTask(id, { timeoutMs: 10000, tickMs: 20 }) }
    await registry.shutdown()
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  })
  // Ordinary disposable repository only: no configured-program fixtures or
  // hook/filter executions, and no inherited initialization template.
  await exec('git', ['init', '--quiet', '--template=', cwd], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice } })
  await writeFile(path.join(cwd, 'sample.txt'), 'ordinary fixture\n')
  const config = { permission: { level: 'yolo', rules: [] }, tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } } }
  await registry.initialize({ cwd, config, allowProjectSources: false })
  const run = (args, sandbox = null) => registry.call('bash', args, { cwd, sessionId: 'git-owner', turnId: 'git-turn',
    config: { ...config, permission: { ...config.permission, ...(sandbox ? { sandbox } : {}) } } })
  return { run, ids }
}

test('ordinary safe Git Bash uses the controlled native invocation with structured process result', async t => {
  const { run } = await fixture(t)
  const result = await run({ command: 'git status --short' })
  assert.equal(result.status, 'completed', result.output)
  assert.equal(result.metadata.exitCode, 0)
  assert.equal(result.metadata.executionAdapter, 'controlled-git-read')
  assert.match(result.output, /sample\.txt/)
})

test('background safe Git shares the same controlled invocation and actual terminal receipt', async t => {
  const { run, ids } = await fixture(t)
  const launched = await run({ command: 'git status --short', run_in_background: true })
  const id = launched.metadata.backgroundTask.id; ids.push(id)
  const task = await BackgroundManager.waitForTask(id, { timeoutMs: 10000, tickMs: 20 })
  assert.equal(task.status, 'completed')
  assert.equal(task.result.metadata.executionAdapter, 'controlled-git-read')
  assert.equal(task.result.metadata.exitCode, 0)
  assert.match(task.result.output, /sample\.txt/)
})

test('controlled Git argv also executes inside an available real OS sandbox', async t => {
  if (process.platform !== 'darwin' && !(process.platform === 'linux' && await probeBwrap())) {
    t.skip('requires an actual bwrap or macOS sandbox-exec backend'); return
  }
  const { run } = await fixture(t)
  const result = await run({ command: 'git status --short' }, { mode: 'auto', network: false })
  assert.equal(result.status, 'completed', result.output)
  assert.equal(result.metadata.executionAdapter, 'controlled-git-read')
  assert.match(result.output, /sample\.txt/)
})
