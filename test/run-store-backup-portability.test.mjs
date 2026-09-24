import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { openRunStore, runStoreNodeArgs } from '../src/storage/run-store.mjs'
import { redactedStorageFailure } from '../src/storage/run-store-errors.mjs'

for (const mask of ['077', '022']) test(`backup flush handles are writable without truncation under umask ${mask}, including the Windows FlushFileBuffers requirement`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-backup-portable-')), directory = path.join(root, 'ledger')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await openRunStore({ directory }); t.after(() => store.close())
  const expected = await store.createRun({ id: 'preserved', ownerId: 'fixture', contract: { objective: 'Preserve durable state', requiredCriteria: [] } })
  await store.close()
  const file = path.join(directory, 'runs.sqlite'), originalBytes = await readFile(file)
  // SQLite remains in a child even for this direct fsync probe, so the minimum
  // Node 22.12 runner does not need global --experimental-sqlite flags.
  const { stdout } = await promisify(execFile)(process.execPath, [...runStoreNodeArgs(), fileURLToPath(new URL('./fixtures/run-store-backup-flush.mjs', import.meta.url)), file, path.join(root, 'restored'), mask])
  const result = JSON.parse(stdout)
  assert.equal(result.version, 2)
  assert.equal(result.umask, Number.parseInt(mask, 8))
  if (process.platform !== 'win32') {
    assert.equal(result.snapshotMode, 0o600)
    assert.equal(result.restoredMode, 0o600)
  }
  assert.ok(result.writableFileFlushes >= 3, 'snapshot, manifest and restored file must really flush')
  assert.deepEqual(await readFile(file), originalBytes, 'flushing a backup must not change the original database')
  const reopened = await openRunStore({ directory: path.join(root, 'restored') }); t.after(() => reopened.close())
  assert.deepEqual(await reopened.getRun(expected.id), expected)
  await reopened.close()
})

test('storage diagnostics retain only fixed OS/SQLite cause codes and never private error text', () => {
  const error = Object.assign(new Error('secret token in /private/credentials'), { code: 'EPERM', syscall: 'fsync', path: '/private/credentials' })
  assert.deepEqual(redactedStorageFailure(error, 'createBackup'), { code: 'STORE_UNAVAILABLE',
    message: 'Durable run storage failed (operation=createBackup, causeCode=EPERM, syscall=fsync); do not retry effects until persisted state has been inspected' })
  const sqlite = redactedStorageFailure({ code: 'ERR_SQLITE_ERROR', errcode: 8, errstr: 'secret SQL text' }, 'initialize')
  assert.match(sqlite.message, /sqliteCode=8/)
  for (const value of [error, { code: 'SECRET_API_KEY', syscall: '/private/secret', message: 'private bytes', errcode: 'secret' }, null]) {
    const result = redactedStorageFailure(value, '/private/secret')
    assert.equal(JSON.stringify(result).includes('secret'), false)
    assert.equal(JSON.stringify(result).includes('/private'), false)
  }
})

test('actual worker backup failures expose a safe cause code without filesystem paths', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kk-private-backup-fixture-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await openRunStore({ directory }); t.after(() => store.close())
  await writeFile(path.join(directory, 'backups'), 'conflicting ordinary file', { mode: 0o600 })
  await assert.rejects(store.createBackup(), error => {
    assert.equal(error.code, 'STORE_UNAVAILABLE')
    assert.match(error.message, /operation=createBackup, causeCode=(EEXIST|ENOTDIR)/)
    assert.equal(error.message.includes(directory), false)
    assert.equal(error.message.includes('conflicting ordinary file'), false)
    return true
  })
  await store.close()
})
