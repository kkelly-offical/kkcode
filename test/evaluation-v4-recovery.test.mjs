import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { prepareTask } from '../evaluation/v1/runner.mjs'
import { cases } from '../evaluation/v4/manifest.mjs'
import { cases as historical } from '../evaluation/v3/manifest.mjs'
import { runRecoveryScenario, verifyRecoveryEvidence } from '../evaluation/v1/recovery-drivers.mjs'

const task = cases.find(item => item.id === 'C04')
const enabled = { skip: process.platform !== 'linux' || !process.env.KKCODE_STRICT_TEST_IMAGE, timeout: 90000 }
async function run(t, { counterFault = null, negativeControl = false, selected = task } = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'kk-v4-counter-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const fixture = await prepareTask(selected, { parent })
  const execution = await runRecoveryScenario({ task: selected, cwd: fixture.cwd, privateRoot: path.join(fixture.root, 'control'),
    image: process.env.KKCODE_STRICT_TEST_IMAGE, mode: 'system-selfcheck', budgetUsd: 0, deadlineAt: Date.now() + 80000, counterFault, negativeControl,
    graderRevision: selected === task ? 4 : 1 })
  assert.equal(await readFile(path.join(fixture.cwd, 'original.txt'), 'utf8'), selected.fixtureFiles['original.txt'])
  return { execution, counter: await readFile(path.join(fixture.cwd, 'counter.txt'), 'utf8') }
}

test('v4 reconnects at the actual increment, accepts its newline and unrelated readonly Bash calls', enabled, async t => {
  const { execution, counter } = await run(t)
  assert.equal(counter, '1\n')
  assert.equal(verifyRecoveryEvidence(task, execution).passed, true, JSON.stringify(execution.oracleChecks))
  assert.equal(execution.actions.filter(action => action.kind === 'tool.bash').length, 3)
  const proof = execution.operations.find(item => item.kind === 'bound-counter-invocation')
  assert.equal(proof.boundary.action.state, 'prepared')
  assert.notEqual(proof.boundary.action.id, execution.actions[0].id, 'the first readonly Bash must not stand in for the increment')
  assert.equal(proof.actualExecutions.filter(item => item.operationId === proof.boundary.action.id).length, 1)
  assert.deepEqual(proof.subscriptions.first.map(event => event.type), ['tool.start'])
  assert.deepEqual(proof.subscriptions.second.map(event => event.type), ['tool.finish'])
})

for (const counterFault of ['repeat-original', 'repeat-and-restore']) test(`v4 rejects an actual original increment replay (${counterFault})`, enabled, async t => {
  const { execution, counter } = await run(t, { counterFault })
  assert.equal(counter, counterFault === 'repeat-and-restore' ? '1\n' : '2\n')
  assert.equal(verifyRecoveryEvidence(task, execution).passed, false)
  assert.ok(execution.oracleChecks.some(check => check.name === 'bound-counter-invocation-not-reexecuted' && !check.passed))
  const proof = execution.operations.find(item => item.kind === 'bound-counter-invocation')
  assert.equal(proof.actualExecutions.filter(item => item.operationId === proof.boundary.action.id && item.completed).length, 2)
})

test('v4 rejects a run whose real increment completes without subscriber reattachment', enabled, async t => {
  const { execution, counter } = await run(t, { negativeControl: true })
  assert.equal(counter, '1\n')
  assert.equal(verifyRecoveryEvidence(task, execution).passed, false)
  assert.ok(execution.oracleChecks.some(check => check.name === 'real-subscriber-reconnect-at-pending-increment' && !check.passed))
})

test('v3 C04 retains its original single-Bash measurement and raw-text counter behavior', enabled, async t => {
  const selected = historical.find(item => item.id === 'C04')
  const { execution, counter } = await run(t, { selected })
  assert.equal(counter, '1')
  assert.equal(execution.actions.filter(action => action.kind === 'tool.bash').length, 1)
  assert.equal(verifyRecoveryEvidence(selected, execution).passed, true)
  assert.ok(execution.oracleChecks.some(check => check.name === 'real-subscriber-reconnect-preserves-running-turn'))
  assert.equal(execution.operations.some(item => item.kind === 'bound-counter-invocation'), false)
})
