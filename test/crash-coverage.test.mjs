import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const helper = new URL('./helpers/crash-coverage.mjs', import.meta.url).href
const policy = new URL('../src/kernel/permission/data-policy.mjs', import.meta.url).href

for (const enabled of [false, true]) test(`crash coverage checkpoint ${enabled ? 'retains real product counters before SIGKILL' : 'does not enable disabled coverage'}`, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kkcode-crash-coverage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const worker = fork(new URL('./fixtures/crash-coverage-worker.mjs', import.meta.url), [helper, policy], {
    execArgv: [], env: { ...process.env, NODE_V8_COVERAGE: enabled ? directory : '' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  })
  const exited = once(worker, 'exit')
  t.after(async () => { if (worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGKILL'); await exited } })
  let stderr = ''
  worker.stderr.on('data', chunk => { stderr += chunk })
  const [message] = await Promise.race([once(worker, 'message'), exited.then(() => { throw new Error(`checkpoint worker exited early: ${stderr}`) })])
  assert.deepEqual(message, { checkpointed: enabled, result: { model_origins: ['https://fixture.invalid'] } })
  const files = await readdir(directory)
  if (enabled) {
    assert.ok(files.length > 0, 'coverage must exist before the parent is allowed to kill')
    const reports = await Promise.all(files.map(file => readFile(path.join(directory, file), 'utf8').then(JSON.parse)))
    assert.ok(reports.flatMap(report => report.result).some(script => script.url === policy && script.functions.some(fn => fn.ranges.some(range => range.count > 0))), 'executed product code remains measured, not excluded')
  } else assert.deepEqual(files, [])
  assert.equal(worker.kill('SIGKILL'), true)
  const [, signal] = await exited
  assert.equal(signal, 'SIGKILL')
  assert.deepEqual(await readdir(directory), files, 'forced termination does not add an interrupted report')
  for (const file of files) JSON.parse(await readFile(path.join(directory, file), 'utf8'))
})
