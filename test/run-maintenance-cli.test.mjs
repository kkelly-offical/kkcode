import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { openRunStore } from '../src/storage/run-store.mjs'
import { createRunsCommand } from '../src/commands/runs.mjs'

async function invoke(args) {
  const original = console.log, output = []
  console.log = value => output.push(value)
  try { await createRunsCommand().parseAsync(['node', 'runs', ...args]); return output.map(value => JSON.parse(value)).at(-1) }
  finally { console.log = original }
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-run-cli-maint-')), old = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  t.after(async () => { if (old === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = old; await rm(root, { recursive: true, force: true }) })
  return { root, directory: path.join(root, 'ledger') }
}
test('backup CLI previews restoration, verifies real SQLite snapshots and never overwrites the live database', async t => {
  const f = await fixture(t), store = await openRunStore({ directory: f.directory })
  await store.createRun({ id: 'kept', ownerId: 'host', contract: { objective: 'Preserve this record', requiredCriteria: [] } }); await store.close()
  const args = ['--directory', f.directory, 'backup']
  const backup = await invoke([...args, 'create'])
  assert.equal((await invoke([...args, 'list'])).length, 1)
  assert.equal((await invoke([...args, 'verify', backup.id])).runCount, 1)
  const destination = path.join(f.root, 'restored'), preview = await invoke([...args, 'restore', backup.id, '--to', destination])
  assert.equal(preview.confirmationRequired, true)
  await assert.rejects(access(destination), { code: 'ENOENT' })
  assert.equal((await invoke([...args, 'restore', backup.id, '--to', destination, '--confirm', preview.confirmation])).restored, true)
  const copy = await openRunStore({ directory: destination, readOnly: true })
  assert.equal((await copy.getRun('kept')).contract.objective, 'Preserve this record'); await copy.close()
  await assert.rejects(invoke([...args, 'restore', backup.id, '--to', destination, '--confirm', preview.confirmation]), { code: 'BACKUP_INVALID' })
})
test('migration CLI requires snapshot confirmation and imports only paused historical evidence', async t => {
  const f = await fixture(t), source = path.join(f.root, 'sessions.json'), backup = path.join(f.root, 'backup')
  const bytes = JSON.stringify({ version: 1, sessions: { s1: { cwd: f.root } }, messages: { s1: [{ role: 'user', content: 'kept' }] }, parts: { s1: [] } })
  await writeFile(source, bytes)
  const args = ['--directory', f.directory, 'migrate', '--source', source, '--backup', backup]
  const preview = await invoke(args)
  await assert.rejects(access(path.join(f.directory, 'runs.sqlite')), { code: 'ENOENT' })
  const result = await invoke([...args, '--confirm', preview.confirmation])
  assert.equal(result.originalPreserved, true); assert.equal(await readFile(source, 'utf8'), bytes)
  const store = await openRunStore({ directory: f.directory, readOnly: true })
  assert.equal((await store.getRun(result.imported[0].runId)).state, 'paused'); await store.close()
  assert.equal((await invoke([...args, '--confirm', preview.confirmation])).imported[0].alreadyImported, true)
})
