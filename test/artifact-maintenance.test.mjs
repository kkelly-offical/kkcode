import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, unlink, readdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { ArtifactStore } from '../src/storage/artifact-store.mjs'

const actor = { accountId: 'account-a', projectId: 'project-a', sessionId: 'session-a', runId: 'run-a' }
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-artifact-maintenance-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, store: new ArtifactStore({ root, ...options }) }
}

test('lifecycle reconciliation is idempotent, references prevent collection and retired scopes stay account-bound', async t => {
  let now = 1000
  const { store } = await fixture(t, { clock: () => now, limits: { retentionMs: 100 } })
  const kept = await store.put({ actor, content: 'referenced evidence' })
  const removable = await store.put({ actor, content: 'unreferenced output' })
  const input = { actor, active: false, resolved: true, references: { [kept.id]: ['message-one'] } }
  assert.equal((await store.reconcileRetention(input)).changed, 2)
  now += 101
  assert.equal((await store.reconcileRetention(input)).changed, 0, 'reconciliation cannot perpetually reset TTL')
  assert.deepEqual((await store.prune({ actor })).removed, [removable.id])
  await store.pin({ actor, id: kept.id })
  await store.reconcileRetention({ actor, active: false, resolved: true, retired: true, references: {} })
  now += 101
  assert.deepEqual((await store.pruneRetired({ accountId: actor.accountId })).removed, [])
  await store.pin({ actor, id: kept.id, pinned: false })
  now += 101
  assert.deepEqual((await store.pruneRetired({ accountId: 'another-account' })).removed, [])
  assert.deepEqual((await store.pruneRetired({ accountId: actor.accountId, protectedSessions: [actor.sessionId] })).removed, [])
  assert.deepEqual((await store.pruneRetired({ accountId: actor.accountId })).removed, [kept.id])
})

test('inactive unresolved outcomes cannot be collected, including retired scopes', async t => {
  let now = 0
  const { store } = await fixture(t, { clock: () => now, limits: { retentionMs: 10 } })
  const item = await store.put({ actor, content: 'unknown external action' })
  await store.reconcileRetention({ actor, active: false, resolved: false, retired: true })
  now = 100
  assert.deepEqual((await store.pruneRetired({ accountId: actor.accountId })).removed, [])
  assert.equal((await store.getMetadata({ actor, id: item.id })).size, item.size)
})

test('inspection reports corruption and missing payloads without changing any content', async t => {
  const { store, root } = await fixture(t)
  const first = await store.put({ actor, content: 'one' })
  const second = await store.put({ actor, content: 'two' })
  const catalogFile = path.join(root, 'catalog.json')
  const before = await readFile(catalogFile, 'utf8')
  await writeFile(path.join(root, 'objects', `${first.id}.bin`), 'bad')
  await unlink(path.join(root, 'objects', `${second.id}.bin`))
  const report = await store.inspectStorage()
  assert.equal(report.healthy, false)
  assert.ok(report.issues.some(issue => issue.kind === 'content_mismatch' && issue.artifactId === first.id))
  assert.ok(report.issues.some(issue => issue.kind === 'payload_unavailable' && issue.artifactId === second.id))
  assert.equal(JSON.stringify(report).includes(root), false)
  assert.equal(await readFile(catalogFile, 'utf8'), before)
  await assert.rejects(store.quarantineOrphans({ checkToken: report.checkToken, issueIds: [report.issues[0].id], confirmed: true }), { code: 'artifact_repair_refused' })
})

test('orphan isolation requires explicit current inspection and remains recoverable and capacity-counted', async t => {
  const { store, root } = await fixture(t)
  await store.put({ actor, content: 'valid' })
  const name = `${randomUUID()}.part`, file = path.join(root, 'pending', name)
  await writeFile(file, 'uncommitted evidence', { mode: 0o600 })
  let report = await store.inspectStorage()
  const issue = report.issues.find(item => item.kind === 'orphan_pending')
  assert.ok(issue)
  await assert.rejects(store.quarantineOrphans({ checkToken: report.checkToken, issueIds: [issue.id], confirmed: false }), { code: 'artifact_confirmation_required' })
  await writeFile(file, 'changed uncommitted evidence')
  await assert.rejects(store.quarantineOrphans({ checkToken: report.checkToken, issueIds: [issue.id], confirmed: true }), { code: 'artifact_inspection_stale' })
  report = await store.inspectStorage()
  const result = await store.quarantineOrphans({ checkToken: report.checkToken, issueIds: [report.issues.find(item => item.kind === 'orphan_pending').id], confirmed: true })
  assert.equal(result.recoverable, true)
  assert.deepEqual(await readdir(path.join(root, 'pending')), [])
  const quarantined = await store.inspectStorage()
  assert.equal(quarantined.healthy, true)
  assert.ok(quarantined.quarantinedBytes >= Buffer.byteLength('changed uncommitted evidence'))
  assert.deepEqual(quarantined.recoveries.map(item => item.recoveryId), result.quarantined.map(item => item.recoveryId))
  assert.equal(quarantined.recoveries[0].restorable, true)
  const tight = new ArtifactStore({ root, limits: { deviceBytes: 20 } })
  await assert.rejects(tight.put({ actor, content: 'x' }), { code: 'artifact_quota_exceeded' })
  const recoveryId = result.quarantined[0].recoveryId
  await assert.rejects(store.restoreQuarantined({ recoveryId, confirmed: false }), { code: 'artifact_confirmation_required' })
  assert.equal((await store.restoreQuarantined({ recoveryId, confirmed: true })).restored, true)
  assert.equal(await readFile(file, 'utf8'), 'changed uncommitted evidence')
  assert.ok((await store.inspectStorage()).issues.some(item => item.kind === 'orphan_pending'))
})

test('quarantine restore never overwrites a replacement destination', async t => {
  const { store, root } = await fixture(t)
  await store.put({ actor, content: 'valid' })
  const file = path.join(root, 'pending', `${randomUUID()}.part`)
  await writeFile(file, 'original', { mode: 0o600 })
  const report = await store.inspectStorage()
  const isolated = await store.quarantineOrphans({ checkToken: report.checkToken, issueIds: [report.issues[0].id], confirmed: true })
  await writeFile(file, 'new user evidence', { mode: 0o600 })
  await assert.rejects(store.restoreQuarantined({ recoveryId: isolated.quarantined[0].recoveryId, confirmed: true }), { code: 'EEXIST' })
  assert.equal(await readFile(file, 'utf8'), 'new user evidence')
})

test('a corrupt catalog is inspectable but cannot be repaired by adopting or deleting arbitrary payloads', async t => {
  const { store, root } = await fixture(t)
  await store.put({ actor, content: 'private original' })
  await writeFile(path.join(root, 'catalog.json'), '{broken')
  const before = await readdir(path.join(root, 'objects'))
  const report = await store.inspectStorage()
  assert.ok(report.issues.some(item => item.kind === 'catalog_recovery_required'))
  assert.equal(report.issues.some(item => item.repairable), false)
  await assert.rejects(store.quarantineOrphans({ checkToken: report.checkToken, issueIds: report.issues.map(item => item.id), confirmed: true }), { code: 'artifact_repair_refused' })
  assert.deepEqual(await readdir(path.join(root, 'objects')), before)
  assert.equal(await readFile(path.join(root, 'catalog.json'), 'utf8'), '{broken')
  await writeFile(path.join(root, 'catalog.json'), 'null')
  await assert.rejects(store.list({ actor }), { code: 'artifact_corrupt' })
})
