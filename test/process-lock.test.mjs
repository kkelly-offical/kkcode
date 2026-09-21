import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireProcessLock } from '../src/storage/process-lock.mjs'

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kkcode-process-lock-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, file: path.join(directory, 'device.lock') }
}
function worker(t, file) {
  const child = fork(fileURLToPath(new URL('./fixtures/process-lock-worker.mjs', import.meta.url)), [file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited } })
  return child
}
function ask(child, action) {
  return new Promise((resolve, reject) => {
    const id = randomUUID(), timer = setTimeout(() => { child.off('message', message); reject(new Error('Lock worker timeout')) }, 10000)
    const message = value => { if (value.id === id) { clearTimeout(timer); child.off('message', message); resolve(value) } }
    child.on('message', message); child.send({ id, action })
  })
}
async function kill(child) { const exited = once(child, 'exit'); child.kill(); await exited }

test('one atomic fully published lock wins across independent processes; a live PID is never stolen', async t => {
  const { file, directory } = await fixture(t), children = Array.from({ length: 5 }, () => worker(t, file))
  const outcomes = await Promise.all(children.map(child => ask(child, 'acquire')))
  assert.equal(outcomes.filter(result => result.ok).length, 1)
  assert.ok(outcomes.filter(result => !result.ok).every(result => result.code === 'device_in_use'))
  const winner = outcomes.findIndex(result => result.ok), owner = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(owner.pid, children[winner].pid); assert.equal(owner.token, outcomes[winner].token)
  assert.equal(owner.host, os.hostname()); assert.ok(Number.isFinite(owner.createdAt))
  owner.createdAt = 0; await writeFile(file, JSON.stringify(owner))
  await assert.rejects(acquireProcessLock(file), { code: 'device_in_use' })
  assert.ok(!(await readdir(directory)).some(name => name.endsWith('.candidate')))
  assert.equal((await ask(children[winner], 'release')).ok, true)
  const local = await acquireProcessLock(file); await local.release(); await local.release()
})

test('a terminated owner is recovered once under simultaneous contenders, without deleting the new owner', async t => {
  const { file } = await fixture(t), original = worker(t, file)
  assert.equal((await ask(original, 'acquire')).ok, true); await kill(original)
  const children = Array.from({ length: 4 }, () => worker(t, file)), outcomes = await Promise.all(children.map(child => ask(child, 'acquire')))
  assert.equal(outcomes.filter(result => result.ok).length, 1)
  const winner = outcomes.findIndex(result => result.ok)
  const owner = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(owner.pid, children[winner].pid)
  await assert.rejects(acquireProcessLock(file), { code: 'device_in_use' })
  await ask(children[winner], 'release')
})

test('release cannot unlink another owner and malformed/foreign metadata is fail-closed', async t => {
  const { file } = await fixture(t), local = await acquireProcessLock(file)
  const replacement = { pid: process.pid, token: randomUUID(), host: os.hostname(), createdAt: Date.now() }
  await writeFile(file, JSON.stringify(replacement)); await local.release()
  assert.equal(JSON.parse(await readFile(file, 'utf8')).token, replacement.token)
  for (const content of ['{', '{}', JSON.stringify({ ...replacement, pid: -1 }), JSON.stringify({ ...replacement, host: 'another-host' }), JSON.stringify({ ...replacement, token: '' })]) {
    await writeFile(file, content)
    await assert.rejects(acquireProcessLock(file), { code: 'device_in_use' })
    assert.equal(await readFile(file, 'utf8'), content)
  }
})

test('an interrupted stale-recovery marker remains fail-closed for deliberate local inspection', async t => {
  const { file } = await fixture(t), original = worker(t, file)
  await ask(original, 'acquire'); await kill(original)
  await mkdir(`${file}.recovery`)
  await assert.rejects(acquireProcessLock(file), /recovery is already in progress/)
})
