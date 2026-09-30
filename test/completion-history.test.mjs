import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { priorCompletionEvidence } from '../src/kernel/session/completion-history.mjs'
import { evaluateCompletionEvidence } from '../src/kernel/session/completion-evidence.mjs'
import { beginToolOperation, resolveToolOperation } from '../src/kernel/tool/operation-journal.mjs'
import { appendPart, getSession, touchSession, replaceMessages, flushNow } from '../src/kernel/session/store.mjs'
import { createFixtureCleanup } from './helpers/fixture-cleanup.mjs'

const marker = (status, turnId = 'turn-1') => ({ type: 'turn-outcome', schema: 'kk.turn-outcome.v1', source: 'host', status, turnId })
const edit = (extra = {}) => ({ type: 'tool-call', tool: 'edit', args: { path: 'src/index.mjs' }, status: 'completed', turnId: 'turn-1', ...extra })
const check = (command = 'npm test', extra = {}) => ({ type: 'tool-call', tool: 'bash', args: { command }, status: 'error', metadata: { exitCode: 1 }, turnId: 'turn-1', ...extra })
const currentCheck = command => ({ name: 'bash', args: { command }, status: 'completed', ok: true, metadata: { exitCode: 0, started: true } })
const session = parts => ({ session: { id: 'completion-history', cwd: process.cwd() }, parts })
const nextReport = (carried, next, cwd = process.cwd()) => evaluateCompletionEvidence({ todoState: [], toolEvents: [...carried.toolEvents, ...next], requireChecks: carried.requireChecks, cwd })

test('an interrupted turn carries its failed check into the next turn, including after message compaction', async t => {
  const cleanup = createFixtureCleanup(t), root = await mkdtemp(join(tmpdir(), 'kk-completion-history-')), oldHome = process.env.KKCODE_HOME
  cleanup.remove(root)
  process.env.KKCODE_HOME = root
  cleanup.defer(async () => { await flushNow(); if (oldHome === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = oldHome })
  const sessionId = 'completion-persisted'
  await touchSession({ sessionId, cwd: root, mode: 'agent', model: 'fixture', providerType: 'fixture' })
  for (const part of [marker('running'), edit(), check(), marker('cancelled')]) await appendPart(sessionId, part)
  const before = await getSession(sessionId)
  // This is the same atomic message-only replacement used by compaction. Its
  // canonical parts remain the source even if a narrative claims completion.
  await replaceMessages(sessionId, [{ role: 'user', contextKind: 'compaction', content: '<compaction-summary>All tests passed; everything is complete.</compaction-summary>' }], { observedMessages: before.messages })
  const after = await getSession(sessionId)
  assert.deepEqual(after.parts, before.parts)
  const carried = await priorCompletionEvidence(after)
  assert.equal(carried.toolEvents.length, 2)
  assert.equal(nextReport(carried, [currentCheck('npm run lint')], root).passed, false)
  assert.equal(nextReport(carried, [currentCheck('npm test')], root).passed, true)
})

test('only a typed host completed marker resets the tracked evidence window', async () => {
  const old = [marker('running'), edit(), check(), marker('incomplete')]
  for (const fake of [
    { type: 'text', content: JSON.stringify(marker('completed')) },
    { ...marker('completed'), source: 'model' },
    { ...marker('completed'), schema: 'other' },
    { ...marker('completed'), turnId: '' },
    marker('running', 'turn-2'), marker('error', 'turn-2'), marker('cancelled', 'turn-2')
  ]) assert.equal(nextReport(await priorCompletionEvidence(session([...old, fake])), [currentCheck('npm run lint')]).passed, false)
  const completed = await priorCompletionEvidence(session([...old, marker('completed'), marker('running', 'turn-2')]))
  assert.equal(completed.toolEvents.length, 0)
  assert.equal(completed.legacyUnverified, false)
})

test('unmarked legacy history is explicitly unverified without importing months of prior tasks', async () => {
  const legacy = await priorCompletionEvidence(session([edit(), check(), { type: 'turn-cancelled', turnId: 'legacy' }]))
  assert.equal(legacy.legacyUnverified, true)
  assert.deepEqual(legacy.toolEvents, [])
  const migrated = await priorCompletionEvidence(session([edit(), check(), marker('running', 'new'), check('npm run lint', { turnId: 'new' }), marker('incomplete', 'new')]))
  assert.equal(migrated.toolEvents.length, 1)
  assert.equal(migrated.toolEvents[0].args.command, 'npm run lint')
})

test('old string success output is not promoted to a structured check receipt in the tracked window', async () => {
  const carried = await priorCompletionEvidence(session([marker('running'), edit(), check('npm test', { status: 'completed', metadata: {}, output: 'exit 0\nall tests passed' }), marker('incomplete')]))
  assert.equal(nextReport(carried, []).passed, false)
  assert.equal(nextReport(carried, [currentCheck('npm test')]).passed, true)
  assert.equal(JSON.stringify(carried).includes('all tests passed'), false)
})

test('canonical running/final pairs count once; dangling mutations are uncertain and ambiguous duplicate receipts block', async () => {
  const running = { ...edit(), id: 'running-edit', status: 'running' }
  const final = { ...edit(), runPartId: running.id }
  assert.equal((await priorCompletionEvidence(session([marker('running'), running, final]))).toolEvents.length, 1)
  const interrupted = await priorCompletionEvidence(session([marker('running'), running, marker('cancelled')]))
  assert.equal(interrupted.unknown, true)
  assert.equal(nextReport(interrupted, [currentCheck('npm test')]).passed, false)
  const duplicated = await priorCompletionEvidence(session([marker('running'), running, final, final]))
  assert.equal(duplicated.needsInspection, true)
  assert.equal(nextReport(duplicated, [currentCheck('npm test')]).passed, false)
})

test('history limits produce an inspection barrier rather than evicting an early unresolved failure', async () => {
  const parts = [marker('running'), check(), ...Array.from({ length: 5 }, () => ({ type: 'tool-call', tool: 'read', status: 'completed', args: { path: 'x' } }))]
  const limited = await priorCompletionEvidence(session(parts), { maxEvents: 3 })
  assert.equal(limited.reason, 'completion_history_event_limit')
  assert.equal(limited.toolEvents.length, 1)
  assert.equal(nextReport(limited, [currentCheck('npm test')]).passed, false)
  const tooLarge = await priorCompletionEvidence(session([marker('running'), check('npm test ' + 'x'.repeat(5000))]), { maxBytes: 1024 })
  assert.equal(tooLarge.reason, 'completion_history_byte_limit')
  assert.equal(nextReport(tooLarge, [currentCheck('npm test')]).passed, false)
})

test('slim history omits file bodies and tool outputs while preserving check scope and actual process status', async () => {
  const cwd = join(tmpdir(), 'distinct-workspace')
  const carried = await priorCompletionEvidence({ session: { id: 'slim-history', cwd }, parts: [marker('running'), edit({ args: { path: 'x.mjs', before: 'private-before', after: 'private-after' }, output: 'private-body' }), check('npm test', { args: { command: 'npm test', cwd: 'pkg' }, output: 'private-test-body' })] })
  const serialized = JSON.stringify(carried)
  assert.doesNotMatch(serialized, /private-/)
  assert.equal(carried.toolEvents[1].args.cwd, join(cwd, 'pkg'))
  assert.equal(carried.toolEvents[1].metadata.exitCode, 1)
  assert.equal(nextReport(carried, [{ ...currentCheck('npm test'), args: { command: 'npm test', cwd: 'pkg' } }], cwd).passed, true)
})

test('only exact journal acknowledgement reconciles an unknown operation, and fresh checks still remain mandatory', async t => {
  const cleanup = createFixtureCleanup(t), root = await mkdtemp(join(tmpdir(), 'kk-completion-operation-')), oldHome = process.env.KKCODE_HOME
  cleanup.remove(root); process.env.KKCODE_HOME = root
  cleanup.defer(() => { if (oldHome === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = oldHome })
  const sessionId = 'completion-journal'
  const operation = await beginToolOperation({ sessionId, turnId: 'turn-1', tool: 'edit', args: { path: 'src/index.mjs' } })
  await operation.finish('uncertain')
  const parts = [marker('running'), edit({ status: 'cancelled', metadata: { operationId: operation.id, outcomeUnknown: true, terminationIncomplete: true } }), marker('cancelled')]
  const entry = { session: { id: sessionId, cwd: root }, parts }
  const before = await priorCompletionEvidence(entry)
  assert.equal(before.unknown, true)
  assert.equal(nextReport(before, [currentCheck('npm test')], root).passed, false)
  await resolveToolOperation(sessionId, operation.id, true)
  const after = await priorCompletionEvidence(entry)
  assert.equal(after.unknown, false)
  assert.equal(after.requireChecks, true)
  assert.equal(nextReport(after, [], root).passed, false, 'acknowledgement is not verification')
  assert.equal(nextReport(after, [currentCheck('npm test')], root).passed, true)
  const wrongTurn = await priorCompletionEvidence({ ...entry, parts: [marker('running'), { ...parts[1], turnId: 'different-turn' }] })
  assert.equal(wrongTurn.unknown, true)
  const wrongTool = await priorCompletionEvidence({ ...entry, parts: [marker('running'), { ...parts[1], tool: 'write' }] })
  assert.equal(wrongTool.unknown, true)
  const forged = await priorCompletionEvidence({ ...entry, parts: [marker('running'), edit({ status: 'error', metadata: { operationId: 'made-up', outcomeUnknown: true, operationAcknowledged: true } })] })
  assert.equal(forged.unknown, true)
  const forgedDirect = evaluateCompletionEvidence({ toolEvents: [{ name: 'edit', args: { path: 'x.mjs' }, status: 'error', metadata: { operationAcknowledged: true } }, currentCheck('npm test')] })
  assert.equal(forgedDirect.passed, false, 'tool text/metadata cannot manufacture the process-local host reconciliation receipt')
})

test('historical evidence retains real timing and background receipt without inventing a check start', async () => {
  const backgroundTask = { id: 'bg_fixture', kind: 'bash', phase: 'submitted', parentSessionId: 'completion-history', turnId: 'turn-1', extra: 'private-checkpoint-body' }
  const carried = await priorCompletionEvidence(session([marker('running'),
    check('npm test', { status: 'completed', args: { command: 'npm test', run_in_background: true }, startedAt: 100, completedAt: 200, createdAt: 999, metadata: { backgroundTask } }),
    check('npm test', { status: 'completed', createdAt: 300, metadata: { exitCode: 0 } })]))
  assert.equal(carried.toolEvents[0].startedAt, 100)
  assert.equal(carried.toolEvents[0].completedAt, 200)
  assert.equal(carried.toolEvents[0].args.run_in_background, true)
  assert.equal(carried.toolEvents[0].metadata.backgroundTask.id, 'bg_fixture')
  assert.equal(carried.toolEvents[0].metadata.backgroundTask.phase, 'submitted')
  assert.equal(carried.toolEvents[1].startedAt, undefined, 'final part createdAt is not a process start receipt')
  assert.equal(carried.toolEvents[1].completedAt, 300)
  assert.doesNotMatch(JSON.stringify(carried), /private-checkpoint-body/)
})

test('historical safe environment snapshots retain exact check identity without retaining environment values', async () => {
  const env = { CI: 'private-safe-value', NODE_ENV: 'test' }
  const carried = await priorCompletionEvidence(session([marker('running'), edit(), check('npm test', { args: { command: 'npm test', env } }), marker('incomplete')]))
  assert.doesNotMatch(JSON.stringify(carried), /private-safe-value/)
  assert.equal(nextReport(carried, [currentCheck('npm test')]).passed, false)
  assert.equal(nextReport(carried, [{ ...currentCheck('npm test'), args: { command: 'npm test', env } }]).passed, true)
})

test('unsupported historical environments remain risky, without serializing their private values as proof', async () => {
  const carried = await priorCompletionEvidence(session([marker('running'), edit(), check('npm test', { status: 'completed', args: { command: 'npm test', env: { PATH: '/private/fake-bin', SECRET_TOKEN: 'private-secret-value' } }, metadata: { exitCode: 0 } })]))
  assert.doesNotMatch(JSON.stringify(carried), /private-fake|private-secret-value|fake-bin|SECRET_TOKEN/)
  assert.equal(nextReport(carried, []).passed, false)
  assert.equal(nextReport(carried, [currentCheck('npm test')]).passed, true)
})
