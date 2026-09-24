import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, readFile, writeFile, symlink, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { openRunStore, runStoreNodeArgs } from '../src/storage/run-store.mjs'

const execute = promisify(execFile)
const candidate = 'a'.repeat(64)
const nextCandidate = 'b'.repeat(64)
const contract = { objective: 'Make a verified change without publishing', nonGoals: ['Publish'], allowedPaths: ['src/**'], allowedExternalActions: [], requiredCriteria: [{ id: 'tests', description: 'Independent tests must pass' }] }
const action = { id: 'operation-1', kind: 'file.edit', target: 'src/example.mjs', parameterHash: candidate, effect: 'local_write', retryPolicy: 'reconcile' }
const approved = { approved: true, actorId: 'local-user', reason: 'Explicit recovery confirmed by the host' }
function guard(run) { return { runId: run.id, expectedRevision: run.revision, ownerId: run.ownerId, ownerEpoch: run.ownerEpoch } }

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kk-run-store-'))
  const stores = []
  t.after(async () => { for (const store of stores) await store.close(); await rm(directory, { recursive: true, force: true }) })
  return { directory, async open(options = {}) { const store = await openRunStore({ directory, ...options }); stores.push(store); return store } }
}

test('run store selects minimum-runtime SQLite flags without inheriting CLI flags', () => {
  assert.deepEqual(runStoreNodeArgs('22.12.0'), ['--experimental-sqlite'])
  assert.deepEqual(runStoreNodeArgs('22.13.0'), [])
  assert.deepEqual(runStoreNodeArgs('23.0.0'), ['--experimental-sqlite'])
  assert.deepEqual(runStoreNodeArgs('23.3.0'), ['--experimental-sqlite'])
  assert.deepEqual(runStoreNodeArgs('23.4.0'), [])
  assert.deepEqual(runStoreNodeArgs('24.15.0'), [])
  for (const version of ['20.19.0', '22.11.0', 'invalid']) assert.throws(() => runStoreNodeArgs(version), { code: 'UNSUPPORTED_RUNTIME' })
})

test('an existing empty or truncated SQLite file never silently becomes a new history', async t => {
  const f = await fixture(t)
  const file = path.join(f.directory, 'runs.sqlite')
  await writeFile(file, '', { mode: 0o600 })
  await assert.rejects(f.open(), { code: 'INVALID_STORE' })
  assert.equal((await readFile(file)).length, 0)
  await writeFile(file, 'SQLite format 3\u0000')
  await assert.rejects(f.open())
  assert.equal((await readFile(file)).toString(), 'SQLite format 3\u0000')
})

test('durable run, intent, candidate, verification and events survive close/reopen', async t => {
  const f = await fixture(t)
  let store = await f.open()
  let run = await store.createRun({ id: 'roundtrip', ownerId: 'host-1', contract })
  assert.equal(run.revision, 1)
  assert.equal(run.ownerEpoch, 1)
  run = await store.prepareAction({ ...guard(run), action })
  run = await store.settleAction({ ...guard(run), actionId: action.id, state: 'succeeded', receipt: { evidenceRefs: ['artifact:patch-1'], summary: 'Edit was observed' } })
  run = await store.setCandidate({ ...guard(run), candidateHash: candidate })
  run = await store.recordVerification({ ...guard(run), receipt: { id: 'test-run-1', criterionId: 'tests', candidateHash: candidate, status: 'passed', evidenceRefs: ['artifact:test-report-1'] } })
  run = await store.transitionRun({ ...guard(run), state: 'completed' })
  const events = await store.events({ runId: run.id })
  assert.deepEqual(events.map(event => event.revision), [1, 2, 3, 4, 5, 6])
  assert.ok(events.every((event, index) => index === 0 || event.sequence > events[index - 1].sequence))
  assert.deepEqual(await store.events({ runId: run.id, after: events[3].sequence }), events.slice(4))
  await store.close()
  store = await f.open()
  assert.deepEqual(await store.getRun(run.id), run)
  assert.equal((await store.listRuns({ states: ['completed'] }))[0].id, run.id)
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.directory)).mode & 0o777, 0o700)
    assert.equal((await stat(path.join(f.directory, 'runs.sqlite'))).mode & 0o777, 0o600)
  }
})

test('killed storage process preserves intent; explicit claim fences prior owner and never replays', async t => {
  const f = await fixture(t)
  const original = await f.open()
  let run = await original.createRun({ id: 'recovery', ownerId: 'old-host', contract })
  run = await original.prepareAction({ ...guard(run), action })
  process.kill(original.workerPid, 'SIGKILL')
  await new Promise(resolve => setTimeout(resolve, 30))
  const recovered = await f.open()
  assert.equal((await recovered.getRun(run.id)).actions[0].state, 'prepared')
  await assert.rejects(recovered.claimRun({ runId: run.id, expectedRevision: run.revision, expectedOwnerId: run.ownerId, expectedOwnerEpoch: run.ownerEpoch, ownerId: 'new-host' }), { code: 'INVALID_INPUT' })
  let current = await recovered.claimRun({ runId: run.id, expectedRevision: run.revision, expectedOwnerId: run.ownerId, expectedOwnerEpoch: run.ownerEpoch, ownerId: 'new-host', approval: approved })
  assert.equal(current.state, 'outcome_unknown')
  assert.equal(current.ownerEpoch, 2)
  assert.equal(current.actions.length, 1)
  assert.equal(current.actions[0].state, 'unknown')
  await assert.rejects(recovered.settleAction({ ...guard(run), actionId: action.id, state: 'succeeded' }), { code: 'STALE_OWNER' })
  await assert.rejects(recovered.transitionRun({ ...guard(current), state: 'running' }), { code: 'UNRESOLVED_ACTIONS' })
  await assert.rejects(recovered.settleAction({ ...guard(current), actionId: action.id, state: 'not_applied' }), { code: 'RECONCILIATION_REQUIRED' })
  current = await recovered.settleAction({ ...guard(current), actionId: action.id, state: 'not_applied', receipt: { evidenceRefs: ['artifact:read-only-inspection'] } })
  current = await recovered.transitionRun({ ...guard(current), state: 'running' })
  assert.equal(current.actions[0].state, 'not_applied')
  const duplicate = await recovered.prepareAction({ ...guard(current), action })
  assert.equal(duplicate.revision, current.revision)
  assert.equal(duplicate.actions.length, 1)
})

test('concurrent workers use revision CAS and explicit epoch for takeover', async t => {
  const f = await fixture(t)
  const a = await f.open()
  const b = await f.open()
  const run = await a.createRun({ id: 'concurrent', ownerId: 'host', contract })
  const results = await Promise.allSettled([
    a.prepareAction({ ...guard(run), action }),
    b.prepareAction({ ...guard(run), action: { ...action, id: 'operation-2' } })
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'REVISION_CONFLICT')
  const current = await a.getRun(run.id)
  await assert.rejects(b.claimRun({ runId: run.id, expectedRevision: current.revision, expectedOwnerId: 'host', expectedOwnerEpoch: 9, ownerId: 'host-2', approval: approved }), { code: 'STALE_OWNER' })
  assert.equal((await a.events({ runId: run.id })).length, 2)
})

test('simultaneous first-open workers bootstrap exactly one schema', async t => {
  const f = await fixture(t)
  const stores = await Promise.all(Array.from({ length: 4 }, () => f.open()))
  const created = await stores[0].createRun({ id: 'bootstrap', ownerId: 'host', contract })
  for (const store of stores) assert.deepEqual(await store.getRun(created.id), created)
})

test('no vacuous completion, unknown effects, missing evidence, failed and not-applicable gates', async t => {
  const f = await fixture(t)
  const store = await f.open()
  let draft = await store.createRun({ id: 'empty', ownerId: 'host', contract: { objective: 'Draft only', requiredCriteria: [] } })
  draft = await store.setCandidate({ ...guard(draft), candidateHash: candidate })
  await assert.rejects(store.transitionRun({ ...guard(draft), state: 'completed' }), { code: 'VERIFICATION_REQUIRED' })
  let run = await store.createRun({ id: 'completion', ownerId: 'host', contract })
  await assert.rejects(store.transitionRun({ ...guard(run), state: 'completed' }), { code: 'VERIFICATION_REQUIRED' })
  run = await store.setCandidate({ ...guard(run), candidateHash: candidate })
  for (const status of ['unknown', 'not_applicable', 'failed', 'passed']) {
    run = await store.recordVerification({ ...guard(run), receipt: { id: `test-${status}`, criterionId: 'tests', candidateHash: candidate, status, evidenceRefs: status === 'passed' ? [] : ['artifact:report'] } })
    await assert.rejects(store.transitionRun({ ...guard(run), state: 'completed' }), { code: 'VERIFICATION_REQUIRED' })
  }
  run = await store.recordVerification({ ...guard(run), receipt: { id: 'valid-test', criterionId: 'tests', candidateHash: candidate, status: 'passed', evidenceRefs: ['artifact:valid-report'] } })
  run = await store.prepareAction({ ...guard(run), action })
  await assert.rejects(store.transitionRun({ ...guard(run), state: 'completed' }), { code: 'UNRESOLVED_ACTIONS' })
  run = await store.settleAction({ ...guard(run), actionId: action.id, state: 'unknown' })
  await assert.rejects(store.transitionRun({ ...guard(run), state: 'completed' }), { code: 'UNRESOLVED_ACTIONS' })
})

test('candidate and approved contract revisions invalidate previous acceptance', async t => {
  const f = await fixture(t)
  const store = await f.open()
  let run = await store.createRun({ id: 'invalidation', ownerId: 'host', contract })
  run = await store.setCandidate({ ...guard(run), candidateHash: candidate })
  run = await store.recordVerification({ ...guard(run), receipt: { id: 'first-tests', criterionId: 'tests', candidateHash: candidate, status: 'passed', evidenceRefs: ['artifact:test-report'] } })
  run = await store.setCandidate({ ...guard(run), candidateHash: nextCandidate })
  await assert.rejects(store.recordVerification({ ...guard(run), receipt: { id: 'stale', criterionId: 'tests', candidateHash: candidate, status: 'passed' } }), { code: 'STALE_CANDIDATE' })
  run = await store.setCandidate({ ...guard(run), candidateHash: candidate })
  await assert.rejects(store.transitionRun({ ...guard(run), state: 'completed' }), { code: 'VERIFICATION_REQUIRED' })
  run = await store.recordVerification({ ...guard(run), receipt: { id: 'fresh-tests', criterionId: 'tests', candidateHash: candidate, status: 'passed', evidenceRefs: ['artifact:fresh-report'] } })
  await assert.rejects(store.reviseContract({ ...guard(run), contract: { ...contract, objective: 'Changed' } }), { code: 'INVALID_INPUT' })
  run = await store.reviseContract({ ...guard(run), contract: { ...contract, objective: 'Explicitly changed' }, approval: approved })
  assert.equal(run.contractVersion, 2)
  await assert.rejects(store.transitionRun({ ...guard(run), state: 'completed' }), { code: 'VERIFICATION_REQUIRED' })
})

test('schemas reject unsupported fields, ambiguous IDs and logical operation parameter changes', async t => {
  const f = await fixture(t)
  const store = await f.open()
  await assert.rejects(store.createRun({ ownerId: 'host', contract, bypass: true }), { code: 'INVALID_INPUT' })
  await assert.rejects(store.createRun({ id: '../escape', ownerId: 'host', contract }), { code: 'INVALID_INPUT' })
  await assert.rejects(store.createRun({ ownerId: 'host', contract: { ...contract, requiredCriteria: [contract.requiredCriteria[0], contract.requiredCriteria[0]] } }), { code: 'INVALID_INPUT' })
  await assert.rejects(store.createRun({ ownerId: 'host', contract: { ...contract, allowedTools: ['*'] } }), { code: 'INVALID_INPUT' })
  let run = await store.createRun({ id: 'validate', ownerId: 'host', contract })
  run = await store.prepareAction({ ...guard(run), action })
  await assert.rejects(store.prepareAction({ ...guard(run), action }), { code: 'ACTION_UNRESOLVED' })
  await assert.rejects(store.prepareAction({ ...guard(run), action: { ...action, target: 'another-file' } }), { code: 'ACTION_CONFLICT' })
  await assert.rejects(store.prepareAction({ ...guard(run), action: { ...action, id: 'unsafe-retry', retryPolicy: 'safe' } }), { code: 'INVALID_INPUT' })
  assert.equal((await store.getRun(run.id)).revision, run.revision)
})

test('future schemas, unknown database files and corrupted files fail closed without replacement', async t => {
  const f = await fixture(t)
  let store = await f.open()
  await store.createRun({ id: 'preserved', ownerId: 'host', contract })
  await store.close()
  const database = path.join(f.directory, 'runs.sqlite')
  await execute(process.execPath, [...runStoreNodeArgs(), '--input-type=module', '-e', 'import {DatabaseSync} from "node:sqlite";const db=new DatabaseSync(process.argv[1]);db.exec("PRAGMA user_version=99");db.close()', database])
  const before = await readFile(database)
  await assert.rejects(openRunStore({ directory: f.directory }), { code: 'FUTURE_SCHEMA' })
  assert.deepEqual(await readFile(database), before)
  const broken = path.join(f.directory, 'corrupt')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(broken)
  await writeFile(path.join(broken, 'runs.sqlite'), 'not sqlite and must not be replaced', { mode: 0o600 })
  await assert.rejects(openRunStore({ directory: broken }), { code: 'STORE_UNAVAILABLE' })
  assert.equal(await readFile(path.join(broken, 'runs.sqlite'), 'utf8'), 'not sqlite and must not be replaced')
})

test('migration metadata is checked and symlink store files are rejected', async t => {
  const f = await fixture(t)
  const store = await f.open()
  await store.close()
  const database = path.join(f.directory, 'runs.sqlite')
  await execute(process.execPath, [...runStoreNodeArgs(), '--input-type=module', '-e', 'import {DatabaseSync} from "node:sqlite";const db=new DatabaseSync(process.argv[1]);db.exec("DELETE FROM schema_migrations");db.close()', database])
  await assert.rejects(openRunStore({ directory: f.directory }), { code: 'INVALID_STORE' })
  if (process.platform !== 'win32') {
    const linked = path.join(f.directory, 'linked')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(linked)
    await symlink(database, path.join(linked, 'runs.sqlite'))
    await assert.rejects(openRunStore({ directory: linked }), { code: 'UNSAFE_STORE_PATH' })
  }
})

test('closing storage twice has no handles and rejects later requests', async t => {
  const f = await fixture(t)
  const store = await f.open()
  await Promise.all([store.close(), store.close(), store.close()])
  await assert.rejects(store.listRuns(), { code: 'STORE_CLOSED' })
})

test('read-only inspection cannot create directories, migrate, chmod or mutate application state', async t => {
  const f = await fixture(t)
  const absent = path.join(f.directory, 'absent')
  await assert.rejects(openRunStore({ directory: absent, readOnly: true }))
  await assert.rejects(stat(absent), { code: 'ENOENT' })
  const writer = await f.open()
  const run = await writer.createRun({ id: 'inspect', ownerId: 'host', contract })
  await writer.close()
  const database = path.join(f.directory, 'runs.sqlite')
  const before = await readFile(database)
  const reader = await f.open({ readOnly: true })
  assert.deepEqual(await reader.getRun(run.id), run)
  assert.equal((await reader.events({ runId: run.id })).length, 1)
  assert.equal((await reader.listRuns()).length, 1)
  await assert.rejects(reader.createRun({ ownerId: 'host', contract }), { code: 'READ_ONLY_STORE' })
  await assert.rejects(reader.transitionRun({ ...guard(run), state: 'cancelled' }), { code: 'READ_ONLY_STORE' })
  await reader.close()
  assert.deepEqual(await readFile(database), before)
  // Read-only refers to application state, not SQLite's required WAL coordination.
  assert.ok((await readdir(f.directory)).every(entry => ['runs.sqlite', 'runs.sqlite-wal', 'runs.sqlite-shm'].includes(entry)))
})

test('read-only readers see live commits without mixed-revision action snapshots', async t => {
  const f = await fixture(t)
  const writer = await f.open()
  let run = await writer.createRun({ id: 'live-reader', ownerId: 'host', contract })
  const reader = await f.open({ readOnly: true })
  let done = false
  let updateError
  const updates = (async () => {
    for (let index = 0; index < 30; index++) {
      const operation = { ...action, id: `live-operation-${index}` }
      run = await writer.prepareAction({ ...guard(run), action: operation })
      run = await writer.settleAction({ ...guard(run), actionId: operation.id, state: 'succeeded' })
    }
  })().catch(error => { updateError = error }).finally(() => { done = true })
  let previous = 0
  while (!done) {
    const snapshot = await reader.getRun(run.id)
    assert.ok(snapshot.revision >= previous)
    previous = snapshot.revision
    assert.equal(snapshot.actions.length, Math.ceil((snapshot.revision - 1) / 2))
    assert.equal(snapshot.actions.filter(action => action.state === 'prepared').length, snapshot.revision % 2 === 0 ? 1 : 0)
  }
  await updates
  if (updateError) throw updateError
  assert.deepEqual(await reader.getRun(run.id), run)
})

test('unrelated directories are rejected without changing permissions or creating database files', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kk-run-unrelated-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, 'user-file.txt'), 'preserve me')
  const mode = (await stat(directory)).mode
  await assert.rejects(openRunStore({ directory }), { code: 'UNSAFE_STORE_PATH' })
  assert.equal((await stat(directory)).mode, mode)
  assert.equal(await readFile(path.join(directory, 'user-file.txt'), 'utf8'), 'preserve me')
  await assert.rejects(stat(path.join(directory, 'runs.sqlite')), { code: 'ENOENT' })
})
