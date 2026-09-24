import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { cases, createManifest, validateCatalog, summarizeResults, selectCases } from '../evaluation/v1/manifest.mjs'
import { verifyReferenceDefinitions } from '../evaluation/v1/oracles.mjs'
import { validateLiveProfile } from '../evaluation/v1/live-sdk.mjs'
import { allocateLocalFreeLimits } from '../evaluation/v1/local-free.mjs'
import { evaluationErrorCode, runEvaluation } from '../evaluation/v1/runner.mjs'

test('60 distinct evaluation tasks are reproducible and split 40 development / 20 sealed', () => {
  assert.equal(validateCatalog(), true)
  assert.deepEqual(createManifest(), createManifest())
  assert.equal(selectCases({ split: 'development' }).length, 40)
  assert.equal(selectCases({ split: 'sealed' }).length, 20)
  for (const task of cases.filter(item => item.category === 'repository')) verifyReferenceDefinitions(task)
  for (const task of cases) for (const [name, value] of Object.entries(task.fixtureFiles)) if (name.endsWith('.json')) assert.doesNotThrow(() => JSON.parse(value), task.id)
})

test('public manifest excludes hidden probes, solutions and expected task answers', () => {
  const manifest = createManifest()
  for (const task of manifest.tasks) {
    assert.equal('probes' in task, false); assert.equal('referenceFiles' in task, false)
    assert.equal('expectedResult' in task, false); assert.equal('fixtureFiles' in task, false)
    assert.match(task.taskHash, /^[a-f0-9]{64}$/)
  }
  assert.throws(() => selectCases({ ids: ['R99'] }), /Unknown/)
})

test('selfcheck success cannot satisfy a model-quality release gate', () => {
  const manifest = createManifest()
  const rows = manifest.tasks.map(task => ({ caseId: task.id, mode: 'selfcheck', status: 'passed', safetyPassed: true }))
  const summary = summarizeResults(rows)
  assert.equal(summary.liveResults, 0); assert.equal(summary.successRate, 0)
  assert.equal(summary.releaseGatePassed, false)
})

test('release gate requires every sealed task, two repetitions, same candidate/config and all critical passes', () => {
  const manifest = createManifest()
  const rows = manifest.tasks.flatMap(task => [1, 2].map(repetition => ({ mode: 'live', caseId: task.id, taskHash: task.taskHash, repetition,
    manifestHash: manifest.manifestHash, candidateHash: 'a'.repeat(64), configHash: 'b'.repeat(64), model: 'synthetic-gate-unit-fixture',
    status: 'passed', safetyPassed: true, evidence: { independentOracle: true, durableRunId: 'synthetic-only' } })))
  assert.equal(summarizeResults(rows).releaseGatePassed, true)
  assert.equal(summarizeResults(rows.slice(1)).releaseGatePassed, false)
  const unsupported = structuredClone(rows); unsupported.find(item => item.caseId === 'C15').status = 'unsupported'
  assert.equal(summarizeResults(unsupported).releaseGatePassed, false)
  const changed = structuredClone(rows); changed[0].candidateHash = 'c'.repeat(64)
  assert.equal(summarizeResults(changed).releaseGatePassed, false)
  const duplicate = [...rows, rows[0]]
  assert.equal(summarizeResults(duplicate).releaseGatePassed, false)
  const failedThird = { ...rows.find(item => item.caseId === 'S01'), repetition: 3, status: 'failed' }
  assert.equal(summarizeResults([...rows, failedThird]).criticalPass, false)
})

test('live profiles reject inline secrets and incomplete prices before any model request', () => {
  assert.throws(() => validateLiveProfile({ apiKey: 'not-a-real-key' }), /unknown fields/)
  assert.throws(() => validateLiveProfile({ providerType: 'openai', model: 'fixture', baseUrl: 'https://u:p@example.invalid/' }), /credentials/)
  const previous = process.env.KKCODE_EVALUATION_TEST_KEY
  process.env.KKCODE_EVALUATION_TEST_KEY = 'synthetic-only'
  try {
    const profile = { providerType: 'openai', model: 'fixture', baseUrl: 'https://example.invalid/v1', apiKeyEnv: 'KKCODE_EVALUATION_TEST_KEY', contextLimit: 8192, maxTokens: 1024, pricing: { input: 1, output: 2, cache_read: 1, cache_write: 1 } }
    assert.deepEqual(validateLiveProfile(profile), profile)
    assert.throws(() => validateLiveProfile({ ...profile, pricing: { input: 1 } }), /Complete USD/)
  } finally { if (previous === undefined) delete process.env.KKCODE_EVALUATION_TEST_KEY; else process.env.KKCODE_EVALUATION_TEST_KEY = previous }
})

test('local-free admission is explicit, loopback-only, zero-cost and finitely allocated', () => {
  const previous = process.env.KKCODE_EVALUATION_TEST_KEY
  process.env.KKCODE_EVALUATION_TEST_KEY = 'synthetic-only'
  try {
    const profile = { providerType: 'openai', model: 'fixture', baseUrl: 'http://127.0.0.1:18539/v1', apiKeyEnv: 'KKCODE_EVALUATION_TEST_KEY',
      contextLimit: 262144, maxTokens: 4096, pricing: { input: 0, output: 0, cache_read: 0, cache_write: 0 } }
    assert.throws(() => validateLiveProfile(profile), /explicit host local-free/)
    assert.deepEqual(validateLiveProfile(profile, { localFree: true }), profile)
    for (const baseUrl of ['http://localhost:18539/v1', 'https://example.invalid/v1', 'http://10.0.0.2/v1']) {
      assert.throws(() => validateLiveProfile({ ...profile, baseUrl }, { localFree: true }), /literal loopback/)
    }
    assert.throws(() => validateLiveProfile({ ...profile, pricing: { ...profile.pricing, input: 1 } }, { localFree: true }), /zero USD/)
    const allocation = allocateLocalFreeLimits({ requestLimit: 241, tokenLimit: 120001 }, 120)
    assert.deepEqual(allocation.perTask, { requestLimit: 2, tokenLimit: 1000 })
    assert.ok(allocation.perTask.requestLimit * 120 <= allocation.total.requestLimit)
    assert.throws(() => allocateLocalFreeLimits({ requestLimit: 10, tokenLimit: 1000 }, 120), /every selected task/)
    for (const value of [0, Infinity, NaN, -1, 1.5]) assert.throws(() => allocateLocalFreeLimits({ requestLimit: value, tokenLimit: 1000 }, 1), /finite request/)
  } finally { if (previous === undefined) delete process.env.KKCODE_EVALUATION_TEST_KEY; else process.env.KKCODE_EVALUATION_TEST_KEY = previous }
})

test('operator aborts and numeric DOMException codes remain schema-valid explicit error codes', () => {
  assert.equal(evaluationErrorCode({ code: 20 }, true), 'EVALUATION_ABORTED')
  assert.equal(evaluationErrorCode({ code: 20 }), 'EVALUATION_EXECUTION_ERROR')
  assert.equal(evaluationErrorCode({ code: 'LOCAL_FREE_AUTHORIZATION' }), 'LOCAL_FREE_AUTHORIZATION')
  assert.equal(evaluationErrorCode({ code: '\nnot-a-code' }), 'EVALUATION_EXECUTION_ERROR')
})

test('candidate attestation cannot point at a different repository than the executing runtime', async () => {
  await assert.rejects(runEvaluation({ mode: 'live', ids: ['R01'], image: `sha256:${'a'.repeat(64)}`,
    candidateDirectory: os.tmpdir(), candidateHash: 'b'.repeat(64), deadlineAt: 0 }), /executing runtime source/)
})
