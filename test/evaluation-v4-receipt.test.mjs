import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { prepareTask } from '../evaluation/v1/runner.mjs'
import { cases } from '../evaluation/v4/manifest.mjs'
import { cases as historical } from '../evaluation/v3/manifest.mjs'
import { runRecoveryScenario, verifyRecoveryEvidence } from '../evaluation/v1/recovery-drivers.mjs'

const task = cases.find(item => item.id === 'C10')
const enabled = { skip: process.platform !== 'linux' || !process.env.KKCODE_STRICT_TEST_IMAGE, timeout: 90000 }
async function run(t, { receiptFault = null, negativeControl = false, selected = task } = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'kk-v4-receipt-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const fixture = await prepareTask(selected, { parent })
  const execution = await runRecoveryScenario({ task: selected, cwd: fixture.cwd, privateRoot: path.join(fixture.root, 'control'),
    image: process.env.KKCODE_STRICT_TEST_IMAGE, mode: 'system-selfcheck', budgetUsd: 0, deadlineAt: Date.now() + 80000, receiptFault, negativeControl,
    graderRevision: selected === task ? 4 : 1 })
  assert.equal(await readFile(path.join(fixture.cwd, 'original.txt'), 'utf8'), selected.fixtureFiles['original.txt'])
  assert.equal(await readFile(path.join(fixture.cwd, 'effect-once.txt'), 'utf8'), 'once')
  return execution
}

test('v4 C10 faults the real pending write receipt, not preceding list/read receipts', enabled, async t => {
  const execution = await run(t)
  assert.equal(verifyRecoveryEvidence(task, execution).passed, true, JSON.stringify(execution.oracleChecks))
  assert.deepEqual(execution.actions.map(action => [action.kind, action.state]), [['tool.list', 'succeeded'], ['tool.read', 'succeeded'], ['tool.write', 'unknown']])
  const proof = execution.operations.find(item => item.kind === 'bound-effect-receipt')
  assert.equal(proof.fault.actionId, execution.actions[2].id)
  assert.equal(proof.fault.pendingState, 'prepared')
  assert.equal(proof.boundary.action.effect, 'local_write')
  assert.equal(proof.actualExecutions.filter(item => item.operationId === proof.fault.actionId).length, 1)
  assert.equal(proof.resume.error, 'UNRESOLVED_ACTIONS')
  assert.equal(proof.resume.beforeExecutions, proof.resume.afterExecutions)
})

test('v4 C10 rejects a genuine same-identity write replay even though the file still contains once', enabled, async t => {
  const execution = await run(t, { receiptFault: 'repeat-original' })
  assert.equal(verifyRecoveryEvidence(task, execution).passed, false)
  assert.ok(execution.oracleChecks.some(check => check.name === 'bound-target-effect-not-reexecuted' && !check.passed))
  const proof = execution.operations.find(item => item.kind === 'bound-effect-receipt')
  assert.equal(proof.finalEffect.exact, true)
  assert.equal(proof.actualExecutions.filter(item => item.operationId === proof.fault.actionId && item.completed).length, 2)
})

test('v4 C10 rejects a fault injected into the unrelated first readonly receipt', enabled, async t => {
  const execution = await run(t, { receiptFault: 'wrong-read-receipt' })
  assert.equal(verifyRecoveryEvidence(task, execution).passed, false)
  assert.equal(execution.actions[0].kind, 'tool.list')
  assert.equal(execution.actions[0].state, 'failed')
  assert.equal(execution.actions.find(action => action.kind === 'tool.write').state, 'succeeded')
  assert.ok(execution.oracleChecks.some(check => check.name === 'receipt-fault-bound-to-completed-target-effect' && !check.passed))
})

test('v4 C10 rejects the missing receipt fault instead of accepting the final file alone', enabled, async t => {
  const execution = await run(t, { negativeControl: true })
  assert.equal(verifyRecoveryEvidence(task, execution).passed, false)
  assert.equal(execution.actions.find(action => action.kind === 'tool.write').state, 'succeeded')
})

test('v3 C10 retains its original first-receipt and single-action measurement', enabled, async t => {
  const selected = historical.find(item => item.id === 'C10'), execution = await run(t, { selected })
  assert.equal(verifyRecoveryEvidence(selected, execution).passed, true)
  assert.equal(execution.actions.length, 1)
  assert.ok(execution.oracleChecks.some(check => check.name === 'receipt-failure-blocks-replay'))
  assert.equal(execution.operations.some(item => item.kind === 'bound-effect-receipt'), false)
})
