import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRemoteControl, requestRemoteControl } from '../src/remote/local-control.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-local-control-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('private remote stop uses authenticated IPC, not a PID from a stale status file', async t => {
  const root = await fixture(t)
  let stopped = 0
  const control = await createRemoteControl({ root, onStop: () => { stopped++ } })
  t.after(() => control.close())
  assert.equal((await requestRemoteControl(control, 'status')).pid, process.pid)
  if (process.platform !== 'win32') assert.equal((await stat(control.endpoint)).mode & 0o777, 0o600)
  await assert.rejects(requestRemoteControl({ ...control, token: 'wrong-token', pid: process.pid }, 'stop'), { code: 'remote_control_unavailable' })
  assert.equal(stopped, 0, 'forged stale status must not stop even the current PID')
  assert.equal((await requestRemoteControl(control, 'stop')).ok, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stopped, 1)
  await requestRemoteControl(control, 'stop')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stopped, 1, 'stop is only dispatched once')
})

test('another active local-control endpoint cannot be unlinked or replaced', async t => {
  const root = await fixture(t)
  const control = await createRemoteControl({ root })
  t.after(() => control.close())
  await assert.rejects(createRemoteControl({ root }))
  assert.equal((await requestRemoteControl(control, 'status')).ok, true)
})

test('local-control startup never deletes an unrelated file', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t), file = path.join(root, 'remote-control.sock')
  await writeFile(file, 'preserve unrelated data')
  await assert.rejects(createRemoteControl({ root }), { code: 'remote_control_unavailable' })
  assert.equal(await readFile(file, 'utf8'), 'preserve unrelated data')
})

test('closed or incomplete remote-control records fail safely without signaling any process', async t => {
  const root = await fixture(t), control = await createRemoteControl({ root })
  await control.close()
  await assert.rejects(requestRemoteControl(control, 'stop'), { code: 'remote_control_unavailable' })
  await assert.rejects(requestRemoteControl({ pid: process.pid }, 'stop'), { code: 'remote_control_unavailable' })
})
