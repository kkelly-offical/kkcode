import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, access, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createBackgroundTask, readBackgroundTask, updateBackgroundTask, withBackgroundTaskLock, backgroundTaskOwner } from '../src/kernel/orchestration/background-task-store.mjs'

let fixtureRoot, previousHome
const task = () => ({ id: 'bg_store_fixture', status: 'running', cancelled: false, attempt: 1, resumeToken: 'resume_1', payload: { childOperationId: 'operation_1' }, logs: [] })
beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'kk-background-store-'))
  previousHome = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(fixtureRoot, 'state')
})
afterEach(async () => {
  if (previousHome === undefined) delete process.env.KKCODE_HOME
  else process.env.KKCODE_HOME = previousHome
  await rm(fixtureRoot, { recursive: true, force: true })
})

test('concurrent checkpoint mutations preserve every log and monotonic cancellation', async () => {
  const initial = task()
  await createBackgroundTask(initial)
  await Promise.all([
    ...Array.from({ length: 12 }, (_, index) => updateBackgroundTask(initial.id, current => ({ logs: [...current.logs, index] }))),
    updateBackgroundTask(initial.id, () => ({ cancelled: true }))
  ])
  const current = await readBackgroundTask(initial.id)
  assert.equal(current._version, 13)
  assert.deepEqual(current.logs.slice().sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i))
  assert.equal(current.cancelled, true)
  const { next } = await updateBackgroundTask(initial.id, () => ({ status: 'completed', cancelled: false }), { owner: backgroundTaskOwner(initial), preserveTerminal: true })
  assert.equal(next.status, 'cancelled')
  assert.equal(next.cancelled, true)
  assert.equal(next.interruptionReason, 'user_cancel')
})

test('old attempts cannot overwrite a retry and late worker writes cannot reopen terminal state', async () => {
  const initial = task(), owner = backgroundTaskOwner(initial)
  await createBackgroundTask(initial)
  await updateBackgroundTask(initial.id, () => ({ status: 'interrupted', endedAt: 123 }))
  const late = await updateBackgroundTask(initial.id, () => ({ status: 'running', endedAt: null }), { owner, preserveTerminal: true })
  assert.equal(late.next.status, 'interrupted')
  assert.equal(late.next.endedAt, 123)
  await updateBackgroundTask(initial.id, () => ({ status: 'pending', attempt: 2, resumeToken: 'resume_2' }))
  await assert.rejects(updateBackgroundTask(initial.id, () => ({ status: 'completed' }), { owner, preserveTerminal: true }), { code: 'background_task_stale_owner' })
  assert.equal((await readBackgroundTask(initial.id)).status, 'pending')
})

test('checkpoint IDs are validated before lock directories are created', async () => {
  await assert.rejects(withBackgroundTaskLock('../outside', async () => {}), { code: 'background_task_id' })
  await assert.rejects(readBackgroundTask('../outside'), { code: 'background_task_id' })
  await assert.rejects(access(process.env.KKCODE_HOME), { code: 'ENOENT' })
})

test('live task locks wait only to their bound and release after exceptions', async () => {
  const id = task().id
  await withBackgroundTaskLock(id, async () => {
    await assert.rejects(withBackgroundTaskLock(id, async () => assert.fail('must not steal a live lock'), { timeoutMs: 30 }), { code: 'background_task_busy' })
  })
  await assert.rejects(withBackgroundTaskLock(id, async () => { throw new Error('fixture failure') }), /fixture failure/)
  assert.equal(await withBackgroundTaskLock(id, async () => 'released'), 'released')
})

test('lock storage cannot be redirected with a symbolic link', { skip: process.platform === 'win32' ? 'requires POSIX unprivileged symlinks' : false }, async () => {
  const id = task().id
  await withBackgroundTaskLock(id, async () => {})
  const lockRoot = path.join(process.env.KKCODE_HOME, 'tasks', '.locks')
  await rm(lockRoot, { recursive: true })
  await symlink(fixtureRoot, lockRoot, 'dir')
  await assert.rejects(withBackgroundTaskLock(id, async () => assert.fail('must reject linked locks')), { code: 'background_task_lock_unsafe' })
})
