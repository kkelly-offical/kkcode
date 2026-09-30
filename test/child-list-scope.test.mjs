import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { sessionShardRootPath } from '../src/storage/paths.mjs'
import { listSessions, flushNow } from '../src/kernel/session/store.mjs'
import { createChildController, listChildSnapshots } from '../src/kernel/orchestration/child-controller.mjs'

let root, previousHome
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'kk-child-list-scope-'))
  previousHome = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = root
})
afterEach(async () => {
  await flushNow()
  if (previousHome === undefined) delete process.env.KKCODE_HOME
  else process.env.KKCODE_HOME = previousHome
  await rm(root, { recursive: true, force: true })
})
function child(id, parentSessionId, updatedAt, status = 'running') {
  return { id, parentSessionId, updatedAt, childStatus: status, childOperationId: status === 'running' ? 'operation' : null,
    childContractVersion: 'contract', childContract: { schema: 1, parentSessionId, runSpec: { sessionId: id, parentSessionId, role: { name: 'worker' } } } }
}
async function seed(sessions) {
  const directory = sessionShardRootPath()
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'index.json'), JSON.stringify({ version: 2, updatedAt: Date.now(), sessions: Object.fromEntries(sessions.map(session => [session.id, session])) }), { mode: 0o600 })
}

test('parent filtering precedes pagination and cannot hide an old running child behind unrelated sessions', async () => {
  await seed([child('old_owned', 'owner', 1), ...Array.from({ length: 1001 }, (_, index) => child(`other_${index}`, 'other', index + 2, 'completed'))])
  assert.deepEqual((await listSessions({ parentSessionId: 'owner', limit: 1 })).map(session => session.id), ['old_owned'])
  const controller = createChildController({ parentSessionId: 'owner' })
  const listed = await controller.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].session_id, 'old_owned')
  assert.equal(listed[0].status, 'running')
  const snapshots = await listChildSnapshots('owner')
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].status, 'running')
  assert.equal('result' in snapshots[0], false)
})

test('an overflowing owned list fails explicitly instead of hiding unresolved work outside the page', async () => {
  await seed([child('old_running', 'owner', 1), ...Array.from({ length: 1000 }, (_, index) => child(`done_${index}`, 'owner', index + 2, 'completed'))])
  await assert.rejects(createChildController({ parentSessionId: 'owner' }).list(), { code: 'child_list_overflow' })
  await assert.rejects(listChildSnapshots('owner'), { code: 'child_list_overflow' })
})

test('absent parent scope cannot become a global child controller', async () => {
  await seed([child('owned', 'owner', 1)])
  await assert.rejects(createChildController().list(), /parent session is required/)
  assert.deepEqual(await listChildSnapshots(null), [])
  assert.deepEqual(await createChildController({ parentSessionId: 'unrelated' }).list(), [])
})
