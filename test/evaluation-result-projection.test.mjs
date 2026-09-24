import test from 'node:test'
import assert from 'node:assert/strict'
import { projectEvaluationChecks } from '../evaluation/v4/result-projection.mjs'

test('sealed public checks retain ordinal/boolean/category and cannot expose any synthetic oracle value', () => {
  const marker = 'SYNTHETIC_EXPECTED_DO_NOT_PUBLISH'
  const checks = [
    { name: `text:${marker}`, passed: true, expected: marker, actual: marker, details: { target: marker }, category: marker },
    { name: `formula:${marker}`, passed: false, diagnostic: marker, extra: [marker] }
  ]
  const projected = projectEvaluationChecks({ split: 'sealed', category: 'documents', checks })
  assert.deepEqual(projected.publicChecks, [
    { ordinal: 1, name: 'check-001', passed: true, category: 'documents' },
    { ordinal: 2, name: 'check-002', passed: false, category: 'documents' }
  ])
  assert.doesNotMatch(JSON.stringify(projected), /SYNTHETIC_EXPECTED|expected|actual|details|diagnostic|extra/)
  assert.doesNotMatch(JSON.stringify({ ...projected }), /SYNTHETIC_EXPECTED/)
  assert.deepEqual(Object.keys(projected), ['publicChecks'])
  assert.deepEqual(projected.privateChecks, checks)
})

test('private evidence clones and immutable public checks cannot change each other or original inputs', () => {
  const checks = [{ name: 'SYNTHETIC_ORACLE', passed: false, expected: { value: 'synthetic' } }]
  const projected = projectEvaluationChecks({ split: 'sealed', category: 'repository', checks })
  checks[0].name = 'changed externally'
  const privateCopy = projected.privateChecks
  privateCopy[0].expected.value = 'modified private read'
  assert.equal(projected.privateChecks[0].name, 'SYNTHETIC_ORACLE')
  assert.equal(projected.privateChecks[0].expected.value, 'synthetic')
  assert.throws(() => { projected.publicChecks[0].passed = true }, TypeError)
  assert.equal(projected.publicChecks[0].passed, false)
  assert.throws(() => projected.publicChecks.push({ passed: true }), TypeError)
})

test('projection changes neither development diagnostics nor the count/order/truth of sealed checks', () => {
  const checks = [{ name: 'public-check', passed: false }, { name: 'another-public-check', passed: true }]
  const development = projectEvaluationChecks({ split: 'development', category: 'recovery', checks })
  assert.deepEqual(development.publicChecks, checks)
  assert.notEqual(development.publicChecks, checks)
  for (const category of ['repository', 'recovery', 'safety', 'documents']) {
    const sealed = projectEvaluationChecks({ split: 'sealed', category, checks })
    assert.deepEqual(sealed.publicChecks.map(check => check.passed), [false, true])
    assert.deepEqual(sealed.publicChecks.map(check => check.ordinal), [1, 2])
  }
})

test('malformed checks fail closed with a constant error, without invoking predicate getters', () => {
  let evaluated = 0
  const accessor = { name: 'SYNTHETIC_PRIVATE', get passed() { evaluated++; return true } }
  for (const input of [
    { split: 'unknown', category: 'documents', checks: [] },
    { split: 'sealed', category: 'SYNTHETIC_PRIVATE', checks: [] },
    { split: 'sealed', category: 'documents', checks: [{ name: 'SYNTHETIC_PRIVATE', passed: 'true' }] },
    { split: 'sealed', category: 'documents', checks: [accessor] },
    { split: 'sealed', category: 'documents', checks: [Object.assign(new Date(0), { name: 'synthetic', passed: true })] },
    { split: 'sealed', category: 'documents', checks: Array.from({ length: 1001 }, () => ({ name: 'synthetic', passed: true })) },
    { split: 'sealed', category: 'documents', checks: [{ name: 'synthetic', passed: true, unsafe() {} }] }
  ]) assert.throws(() => projectEvaluationChecks(input), error => {
    assert.equal(error.message, 'Invalid evaluation check projection input')
    return true
  })
  assert.equal(evaluated, 0)
})
