import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { publishEvaluationResult } from '../evaluation/v4/result-publication.mjs'

// Invented canary and result metadata only; no catalog/oracle/model is loaded.
const CANARY = 'INVENTED_PRIVATE_ORACLE_CANARY_84927'
function row(split = 'sealed') {
  const base = { schema: 'kk.evaluation.result.v1', suiteRunId: 'evaluation_11111111-1111-4111-8111-111111111111',
    caseId: 'R99', category: 'repository', split, critical: true, mode: 'selfcheck', repetition: 1,
    manifestHash: 'a'.repeat(64), taskHash: 'b'.repeat(64), candidateHash: 'c'.repeat(64), configHash: 'd'.repeat(64),
    model: null, graderRevision: 4, startedAt: '2026-09-24T00:00:00.000Z' }
  const result = { ...base, endedAt: '2026-09-24T00:00:01.000Z', status: 'failed', safetyPassed: true,
    checks: [{ name: `derived-${CANARY}`, passed: false, actual: CANARY, expected: { secret: CANARY }, detail: CANARY }],
    semanticNegativeRejected: true, sourceProtectionRejected: false, negativeControlRejected: false,
    semanticNegativeChecks: [CANARY], sourceProtectionChecks: [CANARY], diagnostic: CANARY, reason: CANARY, errorCode: CANARY,
    retainedWorkspace: CANARY, unexpectedFutureField: { nested: CANARY }, evidence: { independentOracle: true, oracleReceipt: 'e'.repeat(64), detail: CANARY },
    budget: { spentUsd: 0, unknownUsd: 0, notes: CANARY, requests: [{ status: 'settled', kind: 'model', amountUsd: 0, diagnostics: CANARY }] } }
  return { base, result }
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-private-result-')), output = path.join(root, 'public'), workspace = path.join(root, 'model-workspace'), privateDirectory = path.join(root, 'private')
  await mkdir(output); await mkdir(workspace)
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, output, workspace, privateDirectory }
}

test('v4 sealed runner boundary sends the same canary-free row to disk, accumulator and callback', async t => {
  const f = await fixture(t), { base, result } = row(), results = [], callbacks = []
  const publicRow = await publishEvaluationResult({ suiteVersion: 'v4', base, result, outputDirectory: f.output,
    privateDirectory: f.privateDirectory, workspaceRoots: [f.workspace], results, onResult: value => callbacks.push(value) })
  const disk = JSON.parse(await readFile(path.join(f.output, 'R99-1.json'), 'utf8'))
  assert.deepEqual(disk, publicRow); assert.equal(results[0], publicRow); assert.equal(callbacks[0], publicRow)
  assert.equal(JSON.stringify({ disk, results, callbacks }).includes(CANARY), false)
  assert.equal(publicRow.status, result.status); assert.equal(publicRow.safetyPassed, result.safetyPassed)
  assert.deepEqual(publicRow.checks, [{ ordinal: 1, name: 'check-001', passed: false, category: 'repository' }])
  assert.equal(publicRow.negativeControlRejected, false); assert.equal(publicRow.budget.requests.length, 1)
  assert.equal(Object.isFrozen(publicRow.checks[0]), true)
  const privatePath = path.join(f.privateDirectory, `${publicRow.privateResultId}.json`)
  const privateText = await readFile(privatePath, 'utf8')
  assert.ok(privateText.includes(CANARY))
  assert.deepEqual(JSON.parse(privateText).result, result)
  if (process.platform !== 'win32') { assert.equal((await stat(privatePath)).mode & 0o777, 0o600); assert.equal((await stat(f.privateDirectory)).mode & 0o777, 0o700) }
  assert.deepEqual(await readdir(f.workspace), [])
  assert.deepEqual(await readdir(f.output), ['R99-1.json'])
})

for (const [suiteVersion, split] of [['v1', 'sealed'], ['v2', 'sealed'], ['v3', 'sealed'], ['v4', 'development']]) test(`${suiteVersion}/${split} retains its historical diagnostic representation`, async t => {
  const f = await fixture(t), { base, result } = row(split), results = []
  const published = await publishEvaluationResult({ suiteVersion, base, result, outputDirectory: f.output, results })
  assert.equal(published, result)
  assert.deepEqual(JSON.parse(await readFile(path.join(f.output, 'R99-1.json'), 'utf8')), result)
  assert.ok(JSON.stringify(published).includes(CANARY))
})

for (const location of ['public', 'workspace']) test(`private sealed checks cannot be placed inside the ${location} directory`, async t => {
  const f = await fixture(t), { base, result } = row(), results = []
  await assert.rejects(publishEvaluationResult({ suiteVersion: 'v4', base, result, outputDirectory: f.output,
    privateDirectory: path.join(location === 'public' ? f.output : f.workspace, 'private'), workspaceRoots: [f.workspace], results }), /publication refused/)
  assert.equal(results.length, 0); assert.deepEqual(await readdir(f.output), []); assert.deepEqual(await readdir(f.workspace), [])
})

test('private persistence failure cannot publish a grade or deliver raw data to onResult', async t => {
  const f = await fixture(t), { base, result } = row(), results = []
  let calls = 0
  await assert.rejects(publishEvaluationResult({ suiteVersion: 'v4', base, result, outputDirectory: f.output,
    privateDirectory: f.output, workspaceRoots: [f.workspace], results, onResult: () => { calls++ } }), /publication refused/)
  assert.equal(calls, 0); assert.equal(results.length, 0); assert.deepEqual(await readdir(f.output), [])
})

test('public result schema declares optional grader revision and opaque private receipt without changing old requirements', async () => {
  const schema = JSON.parse(await readFile(new URL('../evaluation/result.schema.json', import.meta.url), 'utf8'))
  assert.deepEqual(schema.properties.graderRevision.enum, [1, 4])
  assert.equal(schema.required.includes('graderRevision'), false)
  assert.equal(schema.required.includes('privateResultId'), false)
  const pattern = new RegExp(schema.properties.privateResultId.pattern)
  assert.ok(pattern.test('sealed_result_11111111-1111-4111-8111-111111111111'))
  assert.equal(pattern.test(`sealed_result_${CANARY}`), false)
})
