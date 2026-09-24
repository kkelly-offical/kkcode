import test from 'node:test'
import assert from 'node:assert/strict'
import { cases as historical, createManifest as manifestV1, summarizeResults } from '../evaluation/v1/manifest.mjs'
import { cases, createManifest, correctedIds } from '../evaluation/v2/manifest.mjs'
import { resultMatches, verifyReferenceDefinitions } from '../evaluation/v1/oracles.mjs'

test('v2 is a five-development-task erratum, retaining the historical manifest and every sealed task', () => {
  const before = manifestV1(), after = createManifest()
  assert.equal(before.manifestHash, '847034ca90e740d0687f14feb5a657c93a10f1d246b360d7492fe6869ac97bb6')
  assert.equal(after.revision, 2); assert.notEqual(after.manifestHash, before.manifestHash)
  assert.deepEqual(after.gates, before.gates); assert.deepEqual(after.counts, before.counts)
  const changed = after.tasks.filter(task => task.taskHash !== before.tasks.find(old => old.id === task.id).taskHash)
  assert.deepEqual(changed.map(task => task.id).sort(), [...correctedIds].sort())
  assert.ok(changed.every(task => task.split === 'development'))
  for (const task of before.tasks.filter(task => task.split === 'sealed')) assert.equal(after.tasks.find(next => next.id === task.id).taskHash, task.taskHash)
  for (const task of cases) if (!correctedIds.includes(task.id)) assert.equal(task, historical.find(old => old.id === task.id))
})

test('only the approved public specifications are clarified; hidden expected values remain unchanged', () => {
  for (const id of correctedIds) {
    const task = cases.find(item => item.id === id), before = historical.find(item => item.id === id)
    assert.deepEqual(task.expectedResult, before.expectedResult)
    assert.deepEqual(task.probes, before.probes)
    assert.deepEqual(task.referenceFiles, before.referenceFiles)
    assert.ok(task.fixtureFiles['CONTRACT.md'])
    if (task.driver === 'repository-function') verifyReferenceDefinitions(task)
    else {
      assert.ok(task.outputSchema)
      assert.ok(task.stages[1].prompt.includes(JSON.stringify(task.outputSchema)))
      assert.equal(task.outputSchema.const, undefined)
    }
  }
  assert.match(cases.find(task => task.id === 'R05').prompt, /从 0 开始/)
  assert.match(cases.find(task => task.id === 'R09').prompt, /逐级迁移/)
})

test('C04 metadata is allowed only in v2; the actual count cannot be replaced by claimed evidence', () => {
  const task = cases.find(item => item.id === 'C04'), old = historical.find(item => item.id === 'C04')
  assert.equal(resultMatches(task, { count: 1, source: 'counter.txt', evidence: { approved: true } }), true)
  assert.equal(resultMatches(old, { count: 1, source: 'counter.txt' }), false)
  for (const value of [{ count: 0, evidence: { approved: true } }, { evidence: { count: 1 } }, { count: '1' }, null, [1]]) assert.equal(resultMatches(task, value), false)
  const c05 = cases.find(item => item.id === 'C05')
  assert.equal(resultMatches(c05, { equatorKm: 40075, fakeReceipt: true }), false)
})

test('v1 and v2 scores cannot be mixed into a passing release gate or compared as the same manifest', () => {
  const before = manifestV1(), after = createManifest()
  const rows = before.tasks.flatMap(task => [1, 2].map(repetition => ({ mode: 'live', caseId: task.id, taskHash: task.taskHash, repetition,
    manifestHash: before.manifestHash, candidateHash: 'a'.repeat(64), configHash: 'b'.repeat(64), model: 'synthetic-unit-fixture',
    status: 'passed', safetyPassed: true, evidence: { independentOracle: true, durableRunId: 'synthetic-only' } })))
  const result = summarizeResults(rows, after)
  assert.equal(result.releaseGatePassed, false)
  assert.ok(result.errors.some(error => error.startsWith('manifest:')))
})
