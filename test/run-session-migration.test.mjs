import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { openRunStore } from '../src/storage/run-store.mjs'
import { createArtifactStore } from '../src/storage/artifact-store.mjs'
import { importLegacySessions, inspectLegacySessions, resolveMigrationBackupDirectory } from '../src/storage/run-session-migration.mjs'

const actor = { accountId: 'migration-account', projectId: 'migration-project' }
const legacy = { version: 1, sessions: { ses_old: { id: 'ses_old', title: 'Historical task', cwd: '/legacy/project' } }, messages: { ses_old: [{ id: 'message-1', role: 'user', content: 'Keep this original history' }] }, parts: { ses_old: [{ id: 'part-1', type: 'tool', output: 'historical result' }] } }
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-session-migration-'))
  const sourceDirectory = path.join(root, 'source')
  await mkdir(sourceDirectory)
  const source = path.join(sourceDirectory, 'session-store.json')
  await writeFile(source, JSON.stringify(legacy), { mode: 0o600 })
  const store = await openRunStore({ directory: path.join(root, 'runs') })
  const artifacts = createArtifactStore({ root: path.join(root, 'artifacts') })
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  return { root, source, sourceDirectory, store, artifacts, actor, ownerId: 'migration-host', backupDirectory: path.join(root, 'backups') }
}

test('legacy migration backs up exact bytes, preserves originals and imports idempotent paused evidence', async t => {
  const f = await fixture(t)
  const before = await readFile(f.source)
  const result = await importLegacySessions(f)
  assert.equal(result.originalPreserved, true)
  assert.equal(result.imported.length, 1)
  assert.deepEqual(await readFile(f.source), before)
  assert.deepEqual(await readFile(path.join(result.backupDirectory, '000000.json')), before)
  const manifest = JSON.parse(await readFile(path.join(result.backupDirectory, 'manifest.json'), 'utf8'))
  assert.equal(manifest.historyCompleteness, 'source_snapshot_only')
  const run = await f.store.getRun(result.imported[0].runId)
  assert.equal(run.state, 'paused')
  assert.equal(run.binding.sessionId, 'ses_old')
  assert.equal(run.binding.contractApprovalRef, undefined)
  const page = await f.artifacts.read({ actor: { ...actor, sessionId: 'ses_old', runId: run.id }, id: run.binding.importedSessionRef })
  assert.deepEqual(JSON.parse(Buffer.from(page.data, 'base64')).session.messages, legacy.messages.ses_old)
  const second = await importLegacySessions(f)
  assert.equal(second.migrationId, result.migrationId)
  assert.equal(second.imported[0].alreadyImported, true)
  assert.equal((await f.store.listRuns()).length, 1)
  await assert.rejects(f.store.transitionRun({ runId: run.id, expectedRevision: run.revision, ownerId: run.ownerId, ownerEpoch: run.ownerEpoch, state: 'completed' }), { code: 'VERIFICATION_REQUIRED' })
})

test('sharded sessions import all source snapshots without replacing the current source index', async t => {
  const f = await fixture(t)
  const source = path.join(f.root, 'shards')
  await mkdir(source)
  await writeFile(path.join(source, 'index.json'), JSON.stringify({ version: 2, sessions: legacy.sessions }))
  await writeFile(path.join(source, 'ses_old.json'), JSON.stringify({ messages: legacy.messages.ses_old, parts: legacy.parts.ses_old }))
  const before = await readFile(path.join(source, 'index.json'))
  const result = await importLegacySessions({ ...f, source })
  assert.equal(result.imported.length, 1)
  const manifest = JSON.parse(await readFile(path.join(result.backupDirectory, 'manifest.json'), 'utf8'))
  assert.equal(manifest.files.length, 2)
  assert.deepEqual(await readFile(path.join(source, 'index.json')), before)
  assert.ok((await readdir(source)).includes('ses_old.json'))
})

test('corrupt and future legacy formats fail closed before any run or backup publication', async t => {
  const f = await fixture(t)
  await writeFile(f.source, '{malformed')
  await assert.rejects(importLegacySessions(f), { code: 'MIGRATION_CORRUPT_SOURCE' })
  assert.equal((await f.store.listRuns()).length, 0)
  assert.equal(await readFile(f.source, 'utf8'), '{malformed')
  await writeFile(f.source, JSON.stringify({ ...legacy, version: 99 }))
  await assert.rejects(importLegacySessions(f), { code: 'MIGRATION_UNSUPPORTED_SOURCE' })
  assert.equal((await f.store.listRuns()).length, 0)
})

test('changed source creates a separate historical snapshot; prior evidence is retained', async t => {
  const f = await fixture(t)
  const first = await importLegacySessions(f)
  const updated = structuredClone(legacy)
  updated.messages.ses_old.push({ id: 'message-2', role: 'assistant', content: 'Later history' })
  await writeFile(f.source, JSON.stringify(updated))
  const second = await importLegacySessions(f)
  assert.notEqual(second.migrationId, first.migrationId)
  assert.notEqual(second.imported[0].runId, first.imported[0].runId)
  assert.equal((await f.store.listRuns()).length, 2)
  assert.deepEqual(JSON.parse(await readFile(path.join(first.backupDirectory, '000000.json'), 'utf8')), legacy)
})

test('preview binds the exact source snapshot and stale approval cannot import changed history', async t => {
  const f = await fixture(t), preview = await inspectLegacySessions(f.source)
  assert.equal(preview.sessions, 1); assert.equal(preview.files, 1)
  assert.equal((await f.store.listRuns()).length, 0)
  await assert.rejects(readdir(f.backupDirectory), { code: 'ENOENT' })
  await writeFile(f.source, JSON.stringify({ ...legacy, messages: { ses_old: [{ role: 'user', content: 'new content after confirmation' }] } }))
  await assert.rejects(importLegacySessions({ ...f, expectedMigrationId: preview.migrationId }), { code: 'MIGRATION_SOURCE_CHANGED' })
  assert.equal((await f.store.listRuns()).length, 0)
  await assert.rejects(readdir(f.backupDirectory), { code: 'ENOENT' })
})

test('a huge shard index is rejected before opening every declared file', async t => {
  const f = await fixture(t), source = path.join(f.root, 'too-many-shards')
  await mkdir(source)
  const sessions = Object.fromEntries(Array.from({ length: 10001 }, (_, index) => [`s${index}`, {}]))
  await writeFile(path.join(source, 'index.json'), JSON.stringify({ version: 2, sessions }))
  await assert.rejects(inspectLegacySessions(source), { code: 'MIGRATION_TOO_LARGE' })
  assert.equal((await f.store.listRuns()).length, 0)
})

test('backup aliases that physically lead into the source are rejected before publication', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), source = path.join(f.root, 'shards'), alias = path.join(f.root, 'backup-alias')
  await mkdir(source)
  await writeFile(path.join(source, 'index.json'), JSON.stringify({ version: 2, sessions: legacy.sessions }))
  await writeFile(path.join(source, 'ses_old.json'), JSON.stringify({ messages: legacy.messages.ses_old, parts: legacy.parts.ses_old }))
  await symlink(source, alias)
  await assert.rejects(importLegacySessions({ ...f, source, backupDirectory: path.join(alias, 'not-created') }), { code: 'MIGRATION_UNSAFE_BACKUP' })
  assert.equal((await f.store.listRuns()).length, 0)
  await assert.rejects(readdir(path.join(source, 'not-created')), { code: 'ENOENT' })
})

test('a backup alias cannot change the confirmed destination even to another valid external directory', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), first = path.join(f.root, 'first'), second = path.join(f.root, 'second'), alias = path.join(f.root, 'alias')
  await mkdir(first); await mkdir(second); await symlink(first, alias)
  const expectedBackupDirectory = await resolveMigrationBackupDirectory(f.source, alias)
  await rm(alias); await symlink(second, alias)
  await assert.rejects(importLegacySessions({ ...f, backupDirectory: alias, expectedBackupDirectory }), { code: 'MIGRATION_UNSAFE_BACKUP' })
  assert.deepEqual(await readdir(second), [])
})

test('interrupted import retries recover an unpublished paused marker without duplicating history', async t => {
  const f = await fixture(t)
  let interrupted = false
  const store = { ...f.store, transitionRun: async input => { if (!interrupted) { interrupted = true; throw new Error('injected before pause publication') } return f.store.transitionRun(input) } }
  await assert.rejects(importLegacySessions({ ...f, store }), /injected/)
  const partial = (await f.store.listRuns())[0]
  assert.equal(partial.state, 'running')
  const recovered = await importLegacySessions(f)
  assert.equal(recovered.imported[0].alreadyImported, true)
  assert.equal((await f.store.getRun(partial.id)).state, 'paused')
  assert.equal((await f.store.listRuns()).length, 1)
  assert.deepEqual(JSON.parse(await readFile(f.source, 'utf8')), legacy)
})
