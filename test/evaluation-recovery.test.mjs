import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { prepareTask } from '../evaluation/v1/runner.mjs'
import { recoveryCases } from '../evaluation/v1/recovery-cases.mjs'
import { runRecoveryScenario, isRecoveryEvidence, verifyRecoveryEvidence } from '../evaluation/v1/recovery-drivers.mjs'

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
