import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { prepareTask } from '../evaluation/v1/runner.mjs'
import { recoveryCases } from '../evaluation/v1/recovery-cases.mjs'
import { runRecoveryScenario, isRecoveryEvidence, verifyRecoveryEvidence, createOwnerEpochRecoveryFixture, ownerEpochRecoveryDefinition } from '../evaluation/v1/recovery-drivers.mjs'

for (const task of recoveryCases) test(`actual recovery lifecycle ${task.id}: ${task.lifecycle}`, { skip: !process.env.KKCODE_STRICT_TEST_IMAGE, timeout: 90000 }, async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'kk-recovery-eval-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const fixture = await prepareTask(task, { parent })
  const execution = await runRecoveryScenario({ task, cwd: fixture.cwd, privateRoot: path.join(fixture.root, 'control'), image: process.env.KKCODE_STRICT_TEST_IMAGE,
    mode: 'system-selfcheck', budgetUsd: 0, deadlineAt: Date.now() + 80000 })
  const verified = verifyRecoveryEvidence(task, execution)
  assert.equal(verified.passed, true, JSON.stringify({ checks: verified.checks, diagnostics: execution.diagnostics, actions: execution.actions }))
  assert.equal(isRecoveryEvidence(execution), true)
  assert.equal(isRecoveryEvidence(structuredClone(execution)), false, 'model JSON cannot forge actual host recovery evidence')
  assert.equal(verifyRecoveryEvidence({ ...task, lifecycle: 'different' }, execution).passed, false)
  assert.equal(execution.modelError, false)
  assert.equal(execution.externalAuthorizedUsd, 0)
  assert.equal(execution.fixtureOnly, true)
  assert.ok(execution.budget.requests.length > 0)
  if (task.expectedResult) assert.deepEqual(JSON.parse(await readFile(path.join(fixture.cwd, 'result.json'), 'utf8')), task.expectedResult)
  assert.equal(await readFile(path.join(fixture.cwd, 'original.txt'), 'utf8'), task.fixtureFiles['original.txt'])
  const prior = execution.lifecycleReceipt; execution.lifecycleReceipt = 'forged'
  assert.equal(isRecoveryEvidence(execution), false)
  execution.lifecycleReceipt = prior
})

for (const task of recoveryCases) test(`recovery lifecycle negative control ${task.id} cannot pass with the required transition absent`, { skip: !process.env.KKCODE_STRICT_TEST_IMAGE, timeout: 90000 }, async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'kk-recovery-negative-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const fixture = await prepareTask(task, { parent })
  const execution = await runRecoveryScenario({ task, cwd: fixture.cwd, privateRoot: path.join(fixture.root, 'control'), image: process.env.KKCODE_STRICT_TEST_IMAGE,
    mode: 'system-selfcheck', budgetUsd: 0, deadlineAt: Date.now() + 80000, negativeControl: true })
  assert.equal(isRecoveryEvidence(execution), true, 'negative evidence is genuinely produced by real host mechanisms')
  const result = verifyRecoveryEvidence(task, execution)
  assert.equal(result.passed, false, JSON.stringify(result))
  assert.ok(result.checks.some(check => check.passed === false))
  assert.equal(await readFile(path.join(fixture.cwd, 'original.txt'), 'utf8'), task.fixtureFiles['original.txt'], 'semantic negative does not corrupt original inputs')
  assert.equal(execution.externalAuthorizedUsd, 0)
})

const publicOwnerTask = Object.freeze({
  id: 'REC02-PUBLIC', category: 'recovery', split: 'development', critical: true,
  title: 'Public synthetic first-tool ownership boundary', driver: 'durable-recovery', lifecycle: 'owner_epoch_takeover',
  prompt: 'Execute only the declared public synthetic first tool.',
  stages: Object.freeze([{ prompt: 'Execute only the declared public synthetic first tool.' }, { action: 'owner_epoch_takeover', prompt: 'Inspect unknown effects without replaying them.' }]),
  fixtureFiles: Object.freeze({ 'package.json': '{"private":true,"type":"module"}\n', 'original.txt': 'Public REC-02 original input.\n' }),
  expectedResult: null, requiredEvidence: Object.freeze(['durableRunId', 'ownerEpoch', 'lifecycleReceipt', 'driverDefinitionHash']), referenceFiles: null
})
const ownerScenarios = [
  { firstTool: 'list', kind: 'tool.list', effect: null },
  { firstTool: 'read', kind: 'tool.read', effect: null },
  { firstTool: 'write', kind: 'tool.write', effect: 'once' },
  { firstTool: 'failed-write', kind: 'tool.write', effect: null, failed: true },
  { firstTool: 'write', kind: 'tool.write', effect: 'once', cancellation: 'before-takeover', runState: 'cancelled' },
  { firstTool: 'write', kind: 'tool.write', effect: 'once', cancellation: 'after-takeover', runState: 'cancelled' }
]
const optionalText = async file => { try { return await readFile(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return null; throw error } }

async function runPublicOwner(t, { firstTool = 'write', cancellation = 'none', fault = null, negativeControl = false } = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'kk-rec02-public-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const fixture = await prepareTask(publicOwnerTask, { parent })
  const execution = await runRecoveryScenario({ task: publicOwnerTask, cwd: fixture.cwd, privateRoot: path.join(fixture.root, 'control'),
    image: 'public-synthetic-rec02', mode: 'system-selfcheck', budgetUsd: 0, deadlineAt: Date.now() + 25000, negativeControl,
    ownerEpochFixture: createOwnerEpochRecoveryFixture({ firstTool, cancellation, fault }) })
  assert.equal(await readFile(path.join(fixture.cwd, 'original.txt'), 'utf8'), publicOwnerTask.fixtureFiles['original.txt'])
  assert.equal(isRecoveryEvidence(execution), true)
  assert.equal(isRecoveryEvidence(structuredClone(execution)), false)
  assert.equal(execution.fixtureOnly, true)
  assert.equal(execution.externalAuthorizedUsd, 0)
  assert.equal(execution.modelError, false)
  assert.equal(execution.driverDefinition, ownerEpochRecoveryDefinition.id)
  assert.equal(execution.driverDefinitionHash, ownerEpochRecoveryDefinition.definitionHash)
  const proof = execution.operations.find(item => item.kind === ownerEpochRecoveryDefinition.id)
  assert.ok(proof, JSON.stringify(execution.operations))
  return { execution, proof, effect: await optionalText(path.join(fixture.cwd, 'effect-once.txt')) }
}

test('REC02 registers an explicit immutable driver definition fingerprint', () => {
  assert.equal(ownerEpochRecoveryDefinition.id, 'owner-epoch-first-tool-rec02-v1')
  assert.equal(ownerEpochRecoveryDefinition.definitionHash, 'b6c080bf21ea046275b1446eb0abc20d3ebde95690466060f1e39110fe1563fb')
  assert.equal(createOwnerEpochRecoveryFixture().definition, ownerEpochRecoveryDefinition)
  assert.equal(Object.isFrozen(ownerEpochRecoveryDefinition), true)
})

test('REC02 public host fixture cannot be enabled for live execution', async () => {
  await assert.rejects(runRecoveryScenario({ task: publicOwnerTask, cwd: process.cwd(), privateRoot: path.join(os.tmpdir(), 'unused-rec02-live'),
    image: 'unused', mode: 'live', profile: {}, budgetUsd: 1, deadlineAt: Date.now() + 10000,
    ownerEpochFixture: createOwnerEpochRecoveryFixture() }), /explicit REC-02 public offline fixture/)
})

for (const scenario of ownerScenarios) {
  const label = `${scenario.firstTool}${scenario.cancellation ? `/${scenario.cancellation}` : ''}`
  test(`REC02 public positive ${label} preserves ownership and unknown-effect fencing`, { timeout: 30000 }, async t => {
    const { execution, proof, effect } = await runPublicOwner(t, scenario)
    const verified = verifyRecoveryEvidence(publicOwnerTask, execution)
    assert.equal(verified.passed, true, JSON.stringify({ checks: verified.checks, diagnostics: execution.diagnostics, proof }))
    assert.equal(effect, scenario.effect)
    assert.equal(execution.runState, scenario.runState || 'outcome_unknown')
    assert.equal(execution.referenceRequests, 1, 'replacement resume must be rejected before another reference request')
    assert.equal(execution.actions.length, 1)
    assert.equal(execution.actions[0].kind, scenario.kind)
    assert.equal(execution.actions[0].state, 'unknown')
    assert.equal(proof.firstToolError, Boolean(scenario.failed))
    assert.equal(proof.oldOwnerExecuteError, 'STALE_OWNER')
    assert.equal(proof.oldOwnerCompleteError, 'STALE_OWNER')
    assert.equal(proof.replacementResumeError, 'UNRESOLVED_ACTIONS')
    assert.equal(proof.executions.length, 1)
    assert.equal(proof.filesystem.effectPresent, scenario.effect !== null)
    if (scenario.cancellation === 'before-takeover') assert.deepEqual(proof.controlSequence.slice(0, 2), ['control.requested', 'run.claimed'])
    else if (scenario.cancellation === 'after-takeover') assert.deepEqual(proof.controlSequence.slice(0, 2), ['run.claimed', 'control.requested'])
    else assert.equal(proof.controlSequence.includes('control.requested'), false)
  })

  test(`REC02 public negative ${label} rejects a missing takeover without requiring a write marker`, { timeout: 30000 }, async t => {
    const { execution, proof, effect } = await runPublicOwner(t, { ...scenario, negativeControl: true })
    const verified = verifyRecoveryEvidence(publicOwnerTask, execution)
    assert.equal(verified.passed, false, JSON.stringify({ checks: verified.checks, proof }))
    assert.ok(verified.checks.some(check => check.name === 'actual-epoch-fence-rejects-old-host' && !check.passed))
    assert.equal(effect, scenario.effect)
    assert.equal(execution.actions.length, 1)
    assert.equal(execution.actions[0].state, scenario.failed ? 'failed' : 'succeeded')
    assert.equal(proof.executions.length, 1)
    assert.equal(proof.replacementResumeError, 'NOT_ATTEMPTED_WITHOUT_UNKNOWN')
    assert.equal(proof.filesystem.effectPresent, scenario.effect !== null)
  })
}

test('REC02 negative control detects a real unknown-write replay even when the final bytes are unchanged', { timeout: 30000 }, async t => {
  const { execution, proof, effect } = await runPublicOwner(t, { firstTool: 'write', fault: 'unknown-effect-replay' })
  const verified = verifyRecoveryEvidence(publicOwnerTask, execution)
  assert.equal(verified.passed, false, JSON.stringify(verified.checks))
  assert.ok(verified.checks.some(check => check.name === 'replacement-owner-cannot-replay-unknown' && !check.passed))
  assert.equal(effect, 'once')
  assert.equal(proof.executions.length, 2)
  assert.equal(new Set(proof.executions.map(item => item.operationId)).size, 1)
  assert.equal(proof.executions[0].operationId, execution.actions[0].id)
  assert.equal(proof.replacementResumeError, 'UNRESOLVED_ACTIONS')
  assert.equal(execution.referenceRequests, 1)
})

test('REC02 negative control rejects an actually committed late result', { timeout: 30000 }, async t => {
  const { execution, proof, effect } = await runPublicOwner(t, { firstTool: 'write', fault: 'late-result-commit' })
  const verified = verifyRecoveryEvidence(publicOwnerTask, execution)
  assert.equal(verified.passed, false, JSON.stringify(verified.checks))
  assert.ok(verified.checks.some(check => check.name === 'late-result-does-not-forge-success' && !check.passed))
  assert.equal(effect, 'once')
  assert.equal(execution.actions[0].state, 'succeeded')
  assert.equal(execution.runState, 'outcome_unknown')
  assert.equal(proof.oldOwnerExecuteError, 'STALE_OWNER')
  assert.equal(proof.oldOwnerCompleteError, 'STALE_OWNER')
  assert.equal(execution.referenceRequests, 1)
})
