import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { openRunStore, createArtifactStore } from '../src/sdk/storage.mjs'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../src/index.mjs', import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex')
const guard = row => ({ runId: row.id, expectedRevision: row.revision, ownerId: row.ownerId, ownerEpoch: row.ownerEpoch })
async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'kkcode-storage-sdk-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('trusted SDK host persists real evidence and completes only its verified candidate', async t => {
  const root = await temporary(t)
  const directory = path.join(root, 'runs')
  const store = await openRunStore({ directory })
  t.after(() => store.close())
  const artifacts = createArtifactStore({ root: path.join(root, 'artifacts') })
  let run = await store.createRun({ id: 'sdk-task', ownerId: 'fixture-host', contract: { objective: '验证候选产物', requiredCriteria: [{ id: 'tests', description: 'fixture exit code is zero' }] } })
  const actor = { accountId: 'fixture-account', projectId: 'fixture-project', sessionId: 'fixture-session', runId: run.id }
  const candidateHash = hash('immutable candidate tree')
  run = await store.setCandidate({ ...guard(run), candidateHash })
  run = await store.prepareAction({ ...guard(run), action: { id: 'test-command-1', kind: 'test', target: 'fixture-project', parameterHash: hash('fixed command'), effect: 'read', retryPolicy: 'safe' } })
  const evidence = await artifacts.put({ actor, content: 'fixture tests passed; exitCode=0', mime: 'text/plain', source: { kind: 'tool', operationId: 'test-command-1' } })
  // This check belongs to the trusted host, not to a model-supplied receipt.
  assert.equal((await artifacts.getMetadata({ actor, id: evidence.id })).sha256, hash('fixture tests passed; exitCode=0'))
  run = await store.settleAction({ ...guard(run), actionId: 'test-command-1', state: 'succeeded', receipt: { evidenceRefs: [evidence.id] } })
  run = await store.recordVerification({ ...guard(run), receipt: { id: 'verified-tests', criterionId: 'tests', candidateHash, status: 'passed', evidenceRefs: [evidence.id] } })
  run = await store.transitionRun({ ...guard(run), state: 'completed' })
  assert.equal(run.state, 'completed')
  await store.close()
  const reader = await openRunStore({ directory, readOnly: true })
  t.after(() => reader.close())
  assert.equal((await reader.getRun(run.id)).state, 'completed')
  await assert.rejects(reader.createRun({ ownerId: 'bad', contract: { objective: 'bad', requiredCriteria: [] } }), /read.only/i)
  const page = await artifacts.read({ actor, id: evidence.id })
  assert.match(Buffer.from(page.data, 'base64').toString('utf8'), /exitCode=0/)
})

test('runs CLI reads a ledger and does not create an absent one', async t => {
  const root = await temporary(t)
  const directory = path.join(root, 'absent')
  const empty = await exec(process.execPath, [cli, 'runs', '--directory', directory, 'list', '--json'], { timeout: 30000 })
  assert.deepEqual(JSON.parse(empty.stdout), [])
  await assert.rejects(access(directory), { code: 'ENOENT' })
  const store = await openRunStore({ directory })
  await store.createRun({ id: 'visible-run', ownerId: 'host', contract: { objective: '检查状态', requiredCriteria: [{ id: 'one', description: 'must verify' }] } })
  await store.close()
  const list = await exec(process.execPath, [cli, 'runs', '--directory', directory, 'list', '--json'], { timeout: 30000 })
  assert.equal(JSON.parse(list.stdout)[0].id, 'visible-run')
  const show = await exec(process.execPath, [cli, 'runs', '--directory', directory, 'show', 'visible-run'], { timeout: 30000 })
  assert.match(show.stdout, /尚无当前版本证据/)
  const events = await exec(process.execPath, [cli, 'runs', '--directory', directory, 'events', 'visible-run'], { timeout: 30000 })
  assert.equal(JSON.parse(events.stdout)[0].type, 'run.created')
  await assert.rejects(exec(process.execPath, [cli, 'runs', '--directory', directory, 'list', '--limit', '-1']), /1–500/)
})

test('storage package export and external strict types expose only deliberate capabilities', async t => {
  const root = await temporary(t)
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(manifest.exports['./sdk/storage'], { types: './src/sdk/storage.d.mts', import: './src/sdk/storage.mjs' })
  const source = path.join(root, 'consumer.mts')
  const sdk = fileURLToPath(new URL('../src/sdk/storage.mjs', import.meta.url)).replaceAll('\\', '/')
  await writeFile(source, `import { openRunStore, createArtifactStore } from ${JSON.stringify(sdk)};
const store = await openRunStore({directory:'./private-runs'});
const run = await store.createRun({ ownerId:'host', contract:{objective:'task', requiredCriteria:[]} });
run.contract.requiredCriteria[0]?.description.toUpperCase();
const reader = await openRunStore({directory:'./private-runs', readOnly:true});
// @ts-expect-error read-only consumer has no mutating surface
reader.prepareAction({});
declare const readOnlyFlag: boolean;
const conditional = await openRunStore({directory:'./private-runs', readOnly:readOnlyFlag});
// @ts-expect-error a dynamic flag cannot promise a writable store
conditional.prepareAction({});
// @ts-expect-error explicit required criteria are required
store.createRun({ownerId:'host', contract:{objective:'task'}});
const artifacts = createArtifactStore();
const actor = {accountId:'a', projectId:'p', sessionId:'s', runId:'r'};
const result = await artifacts.put({actor, content:'evidence'});
const page = await artifacts.read({actor, id:result.id});
page.data.toUpperCase();
// @ts-expect-error scopes cannot be omitted
artifacts.read({id:result.id});
await reader.close(); await store.close();
`)
  const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
  const result = await exec(process.execPath, [compiler, '--ignoreConfig', '--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--skipLibCheck', 'false', source], { timeout: 30000 })
  assert.equal(result.stdout.trim(), '')
})
