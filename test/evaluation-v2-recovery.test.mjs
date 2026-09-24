import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { prepareTask } from '../evaluation/v1/runner.mjs'
import { cases } from '../evaluation/v2/manifest.mjs'
import { runRecoveryScenario, verifyRecoveryEvidence } from '../evaluation/v1/recovery-drivers.mjs'

const task = cases.find(item => item.id === 'C05')
const enabled = { skip: !process.env.KKCODE_STRICT_TEST_IMAGE, timeout: 90000 }
async function run(t, protocolFault = null, negativeControl = false) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'kk-v2-protocol-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const fixture = await prepareTask(task, { parent })
  const execution = await runRecoveryScenario({ task, cwd: fixture.cwd, privateRoot: path.join(fixture.root, 'control'),
    image: process.env.KKCODE_STRICT_TEST_IMAGE, mode: 'system-selfcheck', budgetUsd: 0, deadlineAt: Date.now() + 80000, protocolFault, negativeControl })
  assert.equal(await readFile(path.join(fixture.cwd, 'original.txt'), 'utf8'), task.fixtureFiles['original.txt'])
  return execution
}

test('v2 protocol recovery binds the interrupted original operation to actual backend execution and artifact response', enabled, async t => {
  const execution = await run(t)
  const result = verifyRecoveryEvidence(task, execution)
  assert.equal(result.passed, true, JSON.stringify(result))
  assert.ok(result.checks.some(check => check.name === 'bound-original-invocations-not-reexecuted' && check.passed))
  assert.ok(result.checks.some(check => check.name === 'bound-original-artifact-responses-recovered' && check.passed))
  assert.ok(execution.actions.filter(action => action.kind === 'tool.read' && action.state === 'succeeded').length >= 2,
    'a new explicit model read is allowed while the original invocation remains exactly once')
  const record = execution.operations.find(item => item.kind === 'bound-protocol-invocations')
  assert.ok(record.bindings.length > 0)
  const truncated = execution.operations.find(item => item.kind === 'truncate-after-persisted-tool-use')
  assert.equal(truncated.actionId, record.bindings[0].id)
  assert.deepEqual(truncated.actionIds, record.bindings.map(binding => binding.id))
  for (const binding of record.bindings) assert.equal(record.actualExecutions.filter(item => item.operationId === binding.id).length, 1)
})

test('v2 protocol negative actually executes an old readonly invocation again and rejects it', enabled, async t => {
  const execution = await run(t, 'repeat-original')
  const result = verifyRecoveryEvidence(task, execution)
  assert.equal(result.passed, false)
  assert.ok(result.checks.some(check => check.name === 'bound-original-invocations-not-reexecuted' && !check.passed))
  assert.ok(result.checks.some(check => check.name === 'bound-original-artifact-responses-recovered' && check.passed))
  const repeated = execution.operations.find(item => item.kind === 'fault-real-original-invocation-replay')
  const record = execution.operations.find(item => item.kind === 'bound-protocol-invocations')
  assert.equal(record.actualExecutions.filter(item => item.operationId === repeated.actionId && item.completed).length, 2)
})

test('v2 protocol recovery rejects a genuinely corrupted original artifact instead of trusting claimed counters', enabled, async t => {
  try {
    const execution = await run(t, 'corrupt-artifact')
    const result = verifyRecoveryEvidence(task, execution)
    assert.equal(result.passed, false)
    assert.ok(result.checks.some(check => check.name === 'bound-original-artifact-responses-recovered' && !check.passed))
  } catch (error) {
    assert.ok(['artifact_corrupt', 'artifact_unsafe_storage', 'RECOVERY_HISTORY_UNVERIFIED'].includes(error.code), `unexpected rejection: ${error.code}`)
  }
})

test('v2 still rejects the real missing-lifecycle negative without weakening other safety checks', enabled, async t => {
  const execution = await run(t, null, true)
  assert.equal(verifyRecoveryEvidence(task, execution).passed, false)
})
