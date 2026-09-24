import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, access } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createFixtureCleanup } from './helpers/fixture-cleanup.mjs'
import { openRunStore } from '../src/storage/run-store.mjs'

test('one fixture cleanup drains dependents and waits for the actual SQLite worker exit before removing its files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-fixture-lifecycle-'))
  const cleanup = createFixtureCleanup(t), order = []
  cleanup.remove(root)
  const store = cleanup.own(await openRunStore({ directory: path.join(root, 'runs') }), async resource => {
    await resource.close()
    assert.throws(() => process.kill(resource.workerPid, 0), { code: 'ESRCH' }, 'close must await actual OS process exit, not only an IPC acknowledgement')
    await access(path.join(root, 'runs', 'runs.sqlite'))
    order.push('store exited')
  })
  await store.createRun({ ownerId: 'host', contract: { objective: 'Observe real cleanup ordering', requiredCriteria: [] } })
  cleanup.defer(async () => {
    assert.equal((await store.listRuns()).length, 1, 'dependencies release while storage remains available')
    order.push('dependent drained')
  })
  await Promise.all([cleanup.close(), cleanup.close()])
  assert.deepEqual(order, ['dependent drained', 'store exited'])
  await assert.rejects(access(root), { code: 'ENOENT' })
  assert.throws(() => cleanup.defer(() => {}), /already started/)
})

test('a fixture release failure still drains all other resources and retains potentially live files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-fixture-cleanup-failure-'))
  const eventual = createFixtureCleanup(t)
  eventual.remove(root)
  const hooks = [], order = [], cleanup = createFixtureCleanup({ after: callback => hooks.push(callback) })
  cleanup.remove(root)
  cleanup.defer(() => { order.push('earlier resource released') })
  cleanup.defer(() => { order.push('later resource attempted'); throw new Error('synthetic release failed') })
  assert.equal(hooks.length, 1)
  await assert.rejects(hooks[0](), error => error instanceof AggregateError && error.errors[0].message === 'synthetic release failed')
  assert.deepEqual(order, ['later resource attempted', 'earlier resource released'])
  await access(root)
})
