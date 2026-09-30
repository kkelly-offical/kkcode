import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runManagedProcess } from '../src/kernel/tool/managed-process.mjs'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const node = (code, options = {}, argv = []) => runManagedProcess({ command: process.execPath, args: ['-e', code, ...argv], ...options })

test('already-cancelled managed process does not spawn', async () => {
  const controller = new AbortController(); controller.abort()
  const result = await node("throw new Error('must not run')", { signal: controller.signal })
  assert.equal(result.cancelled, true)
  assert.equal(result.started, false)
  assert.equal(result.exitCode, null)
  assert.equal(result.stdout, '')
})

test('spawn failures settle with structured error and no claimed effects', async () => {
  const result = await runManagedProcess({ command: path.join(os.tmpdir(), `kk-no-executable-${process.pid}`) })
  assert.equal(result.errorCode, 'ENOENT')
  assert.equal(result.started, false)
  assert.equal(result.timedOut, false)
  assert.equal(result.cancelled, false)
})

test('managed capture preserves stdout/stderr bytes and nonzero exit', async () => {
  const result = await node("process.stdout.write('  你好\\n'); process.stderr.write('warning\\n'); process.exitCode = 4")
  assert.equal(result.stdout, '  你好\n')
  assert.equal(result.stderr, 'warning\n')
  assert.equal(result.exitCode, 4)
  assert.equal(result.captureIncomplete, false)
})

test('output cap is a separate failure, not a timeout or cancellation', async () => {
  const result = await node("process.stdout.write('x'.repeat(10000)); setTimeout(() => {}, 1800)", { maxBuffer: 1024, killGraceMs: 20 })
  assert.equal(Buffer.byteLength(result.stdout), 1024)
  assert.equal(result.captureIncomplete, true)
  assert.equal(result.errorCode, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
  assert.equal(result.timedOut, false)
  assert.equal(result.cancelled, false)
})

test('a process terminating by signal is not mislabeled as our timeout', { skip: process.platform === 'win32' ? 'POSIX signal exit observation' : false }, async () => {
  const result = await node("process.kill(process.pid, 'SIGTERM')")
  assert.equal(result.exitCode, null)
  assert.equal(result.exitSignal, 'SIGTERM')
  assert.equal(result.timedOut, false)
  assert.equal(result.cancelled, false)
})

test('exit with inherited open pipes has bounded drain and cannot claim complete capture', { skip: process.platform === 'win32' ? 'POSIX orphan process-group drain; Windows tree acceptance is covered by runtime-process-contract' : false }, async () => {
  const started = Date.now()
  const result = await node("require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1800)'], { stdio: 'inherit' }).unref()", { drainMs: 100, killGraceMs: 20 })
  assert.ok(Date.now() - started < 1300)
  assert.equal(result.exitCode, 0, 'shell exit alone is not proof its inherited pipes drained')
  assert.equal(result.captureIncomplete, true)
})

test('TERM-ignoring descendants with closed pipes still receive final process-group kill', { skip: process.platform === 'win32' ? 'POSIX signal escalation only' : false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-managed-escalation-'))
  const ready = path.join(root, 'ready'), later = path.join(root, 'later')
  const controller = new AbortController()
  const pending = node(`
    const child = "const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.closeSync(1); fs.closeSync(2); fs.writeFileSync(process.argv[1], 'ready'); setTimeout(() => fs.writeFileSync(process.argv[2], 'leaked'), 600); setTimeout(() => {}, 900)";
    require('node:child_process').spawn(process.execPath, ['-e', child, ...process.argv.slice(1)], { stdio: 'inherit' }); setTimeout(() => {}, 1200)
  `, { signal: controller.signal, killGraceMs: 50 }, [ready, later])
  try {
    for (let i = 0; i < 200; i++) { if (await access(ready).then(() => true, () => false)) break; await pause(10) }
    await access(ready)
    controller.abort()
    const result = await pending
    assert.equal(result.cancelled, true)
    await pause(700)
    await assert.rejects(access(later), { code: 'ENOENT' })
  } finally { controller.abort(); await pending; await rm(root, { recursive: true, force: true }) }
})

test('successful owner exit with redirected live children is cleaned up and not reported complete', { skip: process.platform === 'win32' ? 'POSIX group liveness probe; Windows active cancellation has separate coverage' : false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-managed-orphan-'))
  const later = path.join(root, 'later')
  try {
    const result = await node(`
      const child = "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'orphaned'), 800)";
      require('node:child_process').spawn(process.execPath, ['-e', child, process.argv[1]], { stdio: 'ignore' }).unref()
    `, { killGraceMs: 20, drainMs: 100 }, [later])
    assert.equal(result.exitCode, 0)
    assert.equal(result.errorCode, 'PROCESS_CHILDREN_RUNNING')
    assert.equal(result.captureIncomplete, true)
    await pause(900)
    await assert.rejects(access(later), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
