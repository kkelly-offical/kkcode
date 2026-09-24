import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, appendFile, access } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile, fork } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { openRunStore, runStoreNodeArgs } from '../src/storage/run-store.mjs'
import { createFixtureCleanup } from './helpers/fixture-cleanup.mjs'

const exec = promisify(execFile)
const fixtureModule = new URL('./fixtures/run-store-v1.mjs', import.meta.url).href
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kk-run-migrate-'))
  const cleanup = createFixtureCleanup(t)
  cleanup.remove(directory)
  const file = path.join(directory, 'runs.sqlite')
  const script = `import{DatabaseSync}from'node:sqlite';import{schemaV1}from${JSON.stringify(fixtureModule)};process.umask(0o077);const db=new DatabaseSync(process.argv[1]);db.exec(schemaV1);const contract=JSON.stringify({objective:'Preserve legacy state',requiredCriteria:[{id:'check',description:'verify'}],nonGoals:[],allowedPaths:[],allowedExternalActions:[]});db.prepare('INSERT INTO runs(id,state,revision,owner_id,owner_epoch,contract_version,contract_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('legacy','paused',1,'legacy-owner',1,1,contract,1,1);db.prepare('INSERT INTO contracts VALUES(?,1,?,NULL,1)').run('legacy',contract);db.prepare('INSERT INTO events(run_id,revision,type,data_json,created_at) VALUES(?,1,?,?,1)').run('legacy','run.created',JSON.stringify({contractVersion:1,binding:null}));db.close();`
  await exec(process.execPath, [...runStoreNodeArgs(), '--input-type=module', '-e', script, file])
  return { directory, file, cleanup }
}

test('schema 1 upgrades only after a verified consistent backup; restore never overwrites an active DB', async t => {
  const f = await fixture(t)
  const before = await readFile(f.file)
  await assert.rejects(openRunStore({ directory: f.directory, readOnly: true }), { code: 'MIGRATION_REQUIRED' })
  assert.deepEqual(await readFile(f.file), before)
  const store = f.cleanup.own(await openRunStore({ directory: f.directory }))
  const run = await store.getRun('legacy')
  assert.equal(run.state, 'paused'); assert.equal(run.revision, 1)
  const backups = await store.listBackups()
  assert.equal(backups.length, 1); assert.equal(backups[0].version, 1)
  assert.equal((await store.verifyBackup({ id: backups[0].id })).runCount, 1)
  await assert.rejects(store.restoreBackup({ id: backups[0].id, directory: f.directory }), { code: 'BACKUP_INVALID' })
  const restoredDirectory = path.join(path.dirname(f.directory), `kk-run-restored-${randomUUID()}`)
  f.cleanup.remove(restoredDirectory)
  const restored = await store.restoreBackup({ id: backups[0].id, directory: restoredDirectory })
  assert.equal(restored.version, 1)
  const reopened = f.cleanup.own(await openRunStore({ directory: restoredDirectory }))
  assert.deepEqual(await reopened.getRun('legacy'), run)
  await store.close(); await reopened.close()
})

test('an already-open old writer is fenced by schema 2 triggers and its whole transaction rolls back', async t => {
  const f = await fixture(t)
  const old = fork(fileURLToPath(new URL('./fixtures/run-store-old-writer.mjs', import.meta.url)), [f.file], { execArgv: runStoreNodeArgs(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  f.cleanup.defer(async () => {
    if (old.exitCode !== null || old.signalCode !== null) return
    const exited = once(old, 'exit')
    if (old.connected) old.disconnect()
    await exited
  })
  await once(old, 'message')
  const store = f.cleanup.own(await openRunStore({ directory: f.directory }))
  const response = once(old, 'message'); old.send({ write: true })
  const [result] = await response
  assert.equal(result.wrote, false)
  assert.match(result.message, /runtime_upgrade_required/)
  assert.equal((await store.getRun('legacy')).state, 'paused')
  assert.equal((await store.events({ runId: 'legacy' })).length, 1)
  const exited = once(old, 'exit'); old.disconnect(); await exited
})

test('backup corruption fails checksum verification and cannot create a restored database', async t => {
  const f = await fixture(t)
  const store = f.cleanup.own(await openRunStore({ directory: f.directory }))
  const [backup] = await store.listBackups()
  await appendFile(path.join(f.directory, 'backups', `${backup.id}.sqlite`), 'corruption')
  await assert.rejects(store.verifyBackup({ id: backup.id }), { code: 'BACKUP_INVALID' })
  const target = path.join(f.directory, 'bad-restore')
  await assert.rejects(store.restoreBackup({ id: backup.id, directory: target }), { code: 'BACKUP_INVALID' })
  await assert.rejects(access(target), { code: 'ENOENT' })
  assert.equal((await store.getRun('legacy')).state, 'paused')
})

test('manual current-schema backup restores a complete new store', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kk-run-current-backup-'))
  const cleanup = createFixtureCleanup(t)
  cleanup.remove(directory)
  const store = cleanup.own(await openRunStore({ directory }))
  const run = await store.createRun({ id: 'current', ownerId: 'host', contract: { objective: 'Keep current records', requiredCriteria: [] } })
  const backup = await store.createBackup()
  assert.equal(backup.version, 2)
  const restoredDirectory = path.join(path.dirname(directory), `kk-current-restored-${randomUUID()}`)
  cleanup.remove(restoredDirectory)
  await store.restoreBackup({ id: backup.id, directory: restoredDirectory })
  const restored = cleanup.own(await openRunStore({ directory: restoredDirectory }))
  assert.deepEqual(await restored.getRun(run.id), run)
  await store.close(); await restored.close()
})

test('a cancelled parent can persist child cleanup but cannot restart or approve graph work', async t => {
  const f = await fixture(t)
  const store = f.cleanup.own(await openRunStore({ directory: f.directory }))
  let run = await store.getRun('legacy')
  const guard = () => ({ runId: run.id, expectedRevision: run.revision, ownerId: run.ownerId, ownerEpoch: run.ownerEpoch })
  const now = Date.now()
  let graph = { version: 1, id: 'cleanup', revision: 0, ownerEpoch: run.ownerEpoch, createdAt: now, deadlineAt: now + 60000,
    budgetUsd: 1, maxConcurrency: 1, parentCandidateHash: 'a'.repeat(64), baseRevision: 'b'.repeat(40), proposalHash: 'c'.repeat(64), approvalRef: 'approval', status: 'pending',
    nodes: [{ id: 'child', prompt: 'Inspect', role: 'review', dependsOn: [], budgetUsd: 1, deadlineAt: now + 60000, childRunId: 'child-run', sessionId: 'child-session',
      tools: ['read'], criteria: [{ id: 'check', description: 'Inspect evidence' }], state: 'pending', workspace: null, candidateHash: null, evidenceRefs: [], resultArtifactRef: null,
      approvalRef: null, costUsd: 0, errorCode: null, startedAt: null, finishedAt: null }] }
  const save = async next => { const result = await store.updateTaskGraph({ ...guard(), graphId: graph.id, expectedGraphRevision: graph.revision, graph: next }); run = await store.getRun(run.id); graph = result; return result }
  await save(graph)
  await save({ ...graph, status: 'running', nodes: [{ ...graph.nodes[0], state: 'preparing' }] })
  run = await store.transitionRun({ ...guard(), state: 'cancelled' })
  await assert.rejects(save({ ...graph, nodes: [{ ...graph.nodes[0], state: 'ready', workspace: '/private/worktree' }] }), { code: 'TERMINAL_RUN' })
  await save({ ...graph, status: 'blocked', nodes: [{ ...graph.nodes[0], state: 'unknown', errorCode: 'CANCEL_DRAIN_UNKNOWN' }] })
  assert.equal(graph.nodes[0].state, 'unknown')
  await assert.rejects(save({ ...graph, status: 'running', nodes: [{ ...graph.nodes[0], state: 'ready', workspace: '/private/worktree' }] }), { code: 'TERMINAL_RUN' })
  await save({ ...graph, status: 'cancelled', nodes: [{ ...graph.nodes[0], state: 'cancelled' }] })
  assert.equal((await store.getRun(run.id)).state, 'cancelled')
})

test('actual SQLite ENOSPC in an isolated Docker tmpfs preserves existing records and recovers', { skip: !process.env.KKCODE_STRICT_TEST_IMAGE, timeout: 60_000 }, async () => {
  const repository = fileURLToPath(new URL('../', import.meta.url))
  const container = `kkcode-run-diskfull-${randomUUID()}`
  const script = `import{openRunStore}from'/source/src/storage/run-store.mjs';import fs from'node:fs';const directory='/scratch/state/run-store';let store=await openRunStore({directory});await store.createRun({id:'preserved',ownerId:'host',contract:{objective:'Persist before ENOSPC',requiredCriteria:[]}});await store.close();store=await openRunStore({directory});const fd=fs.openSync('/scratch/filler','wx');let full=false;try{for(;;)fs.writeSync(fd,Buffer.alloc(4096))}catch(e){if(e.code!=='ENOSPC')throw e;full=true}finally{fs.closeSync(fd)}let rejected=false;try{await store.createRun({id:'must-not-half-commit',ownerId:'host',contract:{objective:'x'.repeat(32768),requiredCriteria:[]}})}catch{rejected=true}fs.unlinkSync('/scratch/filler');await store.close().catch(()=>{});store=await openRunStore({directory});const prior=await store.getRun('preserved');let absent=false;try{await store.getRun('must-not-half-commit')}catch(e){if(e.code==='RUN_NOT_FOUND')absent=true;else throw e}const next=await store.createRun({id:'after-recovery',ownerId:'host',contract:{objective:'Storage recovered',requiredCriteria:[]}});await store.close();if(!full||!rejected||!absent||prior.revision!==1||next.id!=='after-recovery')throw new Error('ENOSPC damaged durable state');console.log(JSON.stringify({full,rejected,absent,priorKept:true,recovered:true}));`
  try {
    const result = await exec('docker', ['run', '--rm', '--name', container, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--pids-limit', '32', '--memory', '256m', '--tmpfs', '/scratch:rw,nosuid,nodev,size=8m,mode=700', '--mount', `type=bind,src=${repository},dst=/source,readonly`, process.env.KKCODE_STRICT_TEST_IMAGE, 'node', '--input-type=module', '-e', script], { timeout: 50_000, maxBuffer: 1024 * 1024 })
    assert.deepEqual(JSON.parse(result.stdout.trim()), { full: true, rejected: true, absent: true, priorKept: true, recovered: true })
  } finally { await exec('docker', ['rm', '-f', container]).catch(() => {}) }
})
