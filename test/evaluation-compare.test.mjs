import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, link, chmod } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { compareEvaluationReceipts, readEvaluationComparisonBundle } from '../evaluation/v1/compare.mjs'

// Synthetic public metadata only: no sealed task module, oracle or answer is imported.
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)
const hash = value => createHash('sha256').update(canonical(value)).digest('hex')
const seal = body => ({ ...body, id: hash(body) })
const image = `sha256:${'1'.repeat(64)}`, scope = '2'.repeat(64)
function manifest() {
  const tasks = [['R', 20, 'repository'], ['C', 15, 'recovery'], ['S', 15, 'safety'], ['D', 10, 'documents']].flatMap(([prefix, count, category]) => Array.from({ length: count }, (_, i) => {
    const id = `${prefix}${String(i + 1).padStart(2, '0')}`
    return { id, category, critical: ['safety', 'recovery'].includes(category), taskHash: hash(id), fixtureHash: hash(`fixture:${id}`), oracleHash: hash(`oracle-metadata:${id}`) }
  })).map((task, index) => ({ ...task, split: index < 40 ? 'development' : 'sealed' }))
  const value = { schema: 'kk.evaluation.manifest.v1', suite: 'synthetic-60', revision: 1, tasks,
    counts: { repository: 20, recovery: 15, safety: 15, documents: 10, development: 40, sealed: 20 }, gates: { minimumRepetitions: 2, liveSuccessRate: 0.9, criticalSafetyAndRecovery: 1 } }
  return { ...value, manifestHash: hash(value) }
}
function bundle(candidate = 'a', { mode = 'live', configure = value => value, localFree = false } = {}) {
  const m = manifest(), configuration = configure({ profile: mode === 'live' ? { providerType: 'openai', model: 'synthetic-comparison-only', baseUrl: localFree ? 'http://127.0.0.1:18999/v1' : 'https://fixture.invalid/v1', apiKeyEnv: 'NOT_READ_BY_COMPARISON', contextLimit: 65536, maxTokens: 4096, pricing: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } : null,
    image, officeImage: image, mode, budgetUsd: mode === 'live' && !localFree ? 12 : 0, deadlineAt: mode === 'live' ? Date.parse('2026-09-24T12:00:00.000Z') : null,
    localFreeLimits: localFree ? { requestLimit: 240, tokenLimit: 12000000 } : null, repetitions: 2, selectedCases: m.tasks.map(task => task.id) })
  let configHash = hash(configuration), authorization = null
  if (localFree) {
    const policy = seal({ version: 1, provider: 'evaluation', model: configuration.profile.model, protocol: configuration.profile.providerType, baseUrl: configuration.profile.baseUrl,
      scopeHash: scope, maxRequests: 2, maxTokens: 100000, listener: { pid: 123, uid: 1000, fd: 4, inode: '12345', startTimeTicks: '6789', executable: '/private/canary/executable' } })
    configHash = hash({ configuration: configHash, localFreePolicyId: policy.id })
    authorization = { schema: 'kk.evaluation.authorization.v1', configHash, localFreePolicy: policy, totalLimits: configuration.localFreeLimits,
      perTaskLimits: { requestLimit: 2, tokenLimit: 100000 }, deadlineAt: configuration.deadlineAt, budgetUsd: 0 }
  }
  const profile = mode === 'live' ? seal({ version: 1, provider: 'evaluation', model: configuration.profile.model, protocol: configuration.profile.providerType, scopeHash: scope,
    contextLimit: configuration.profile.contextLimit, maxTokens: configuration.profile.maxTokens, compaction: false, rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, source: 'manual' }) : null
  const results = configuration.selectedCases.flatMap(id => Array.from({ length: configuration.repetitions }, (_, index) => {
    const task = m.tasks.find(task => task.id === id)
    return { schema: 'kk.evaluation.result.v1', suiteRunId: `synthetic-${candidate}`, caseId: task.id, category: task.category, split: task.split, critical: task.critical, mode, repetition: index + 1,
      manifestHash: m.manifestHash, taskHash: task.taskHash, candidateHash: candidate.repeat(64), configHash, model: configuration.profile?.model || null,
      status: 'passed', safetyPassed: true, evidence: { independentOracle: true, oracleReceipt: hash('receipt'), candidateTree: hash('tree'), durableRunId: `synthetic-${task.id}-${index + 1}`, lifecycleReceipt: task.category === 'recovery' ? hash('lifecycle') : null },
      checks: [{ name: 'synthetic-independent-check', passed: true }], startedAt: '2026-09-24T00:00:00.000Z', endedAt: '2026-09-24T00:00:02.000Z',
      ...(mode === 'live' ? { budget: { budgetUsd: configuration.budgetUsd / (configuration.selectedCases.length * configuration.repetitions), deadlineAt: configuration.deadlineAt, spentUsd: 0, reservedUsd: 0, unknownUsd: 0, requests: [], profiles: [profile], ...(localFree ? { localFreePolicy: authorization.localFreePolicy, reservedTokens: 90000 } : {}) } }
        : { semanticNegativeRejected: true, sourceProtectionRejected: true, negativeControlRejected: true }) }
  }))
  return { manifest: m, results, authorization, context: { schema: 'kk.evaluation.comparison-context.v1', configuration } }
}

test('different candidates with bound same-model contexts produce paired observations, never significance claims', () => {
  const a = bundle('a'), b = bundle('b')
  a.results[0].status = 'failed'; a.results[0].checks[0].passed = false
  const report = compareEvaluationReceipts(a, b)
  assert.equal(report.recordedConfigurationComparable, true)
  assert.equal(report.experimentVerified, false); assert.equal(report.fullABGateSatisfied, false)
  assert.equal(report.paired.rightOnlyPassed, 1); assert.equal(report.paired.observedPassDelta, 1)
  assert.equal(report.left.denominator, 120); assert.equal(report.right.denominator, 120)
  assert.equal(report.left.failureKinds.functionalFailures, 1)
  assert.equal(report.integrity.signedExecutionProof, false)
  assert.match(report.superiorityConclusion, /不声称统计显著性/)
  assert.equal(report.left.elapsed.observedTaskTotalMs, 240000)
  assert.equal(report.left.budget.reservedTokens.observed, null)
})

test('missing, unrun, infrastructure errors and functional failures stay separate and remain in denominator', () => {
  const a = bundle('a'), b = bundle('b')
  b.results.pop()
  b.results[0].status = 'error'; delete b.results[0].budget
  b.results[1].status = 'not_run'; b.results[2].status = 'unsupported'
  b.results.find(row => row.caseId === 'C01').status = 'failed'
  const report = compareEvaluationReceipts(a, b)
  assert.equal(report.recordedConfigurationComparable, false); assert.ok(report.reasons.includes('incomplete_expected_records'))
  assert.equal(report.right.denominator, 120); assert.equal(report.right.passing, 115)
  assert.equal(report.right.statuses.missing, 1); assert.equal(report.right.statuses.error, 1)
  assert.equal(report.right.criticalSafetyRecovery.passed, false)
  assert.equal(report.right.budget.spentUsd.unavailableRows, 2)
})

test('selfcheck never becomes a model comparison, even with perfect oracle controls', () => {
  const report = compareEvaluationReceipts(bundle('a', { mode: 'selfcheck' }), bundle('b', { mode: 'selfcheck' }))
  assert.equal(report.recordedConfigurationComparable, false)
  assert.ok(report.reasons.includes('selfcheck_or_unknown_mode_not_model_quality'))
})

test('a matching repository-only subset cannot claim that critical safety/recovery gates passed', () => {
  const options = { configure: c => ({ ...c, selectedCases: ['R01', 'R02'] }) }
  const report = compareEvaluationReceipts(bundle('a', options), bundle('b', options))
  assert.equal(report.recordedConfigurationComparable, true)
  assert.equal(report.left.denominator, 4)
  assert.equal(report.left.criticalSafetyRecovery.passed, false)
  assert.equal(report.left.criticalSafetyRecovery.suiteCoverageComplete, false)
})

test('opaque config hash without a context receipt cannot prove a model/endpoint/environment configuration', () => {
  const a = bundle('a'), b = bundle('b'); a.context = null; b.context = null
  const report = compareEvaluationReceipts(a, b)
  assert.equal(report.recordedConfigurationComparable, false); assert.ok(report.reasons.includes('configuration_receipt_missing'))
  assert.equal(report.left.denominator, 120)
})

test('changed environment, endpoint, quotas, model and repetition schedules refuse superiority conclusions', () => {
  for (const configure of [c => ({ ...c, image: `sha256:${'4'.repeat(64)}` }), c => ({ ...c, budgetUsd: 24 }), c => ({ ...c, deadlineAt: c.deadlineAt + 60000 }),
    c => ({ ...c, profile: { ...c.profile, baseUrl: 'https://another.invalid/v1' } }), c => ({ ...c, profile: { ...c.profile, model: 'another-model' } }),
    c => ({ ...c, repetitions: 1 }), c => ({ ...c, selectedCases: c.selectedCases.slice(0, 40) })]) {
    assert.equal(compareEvaluationReceipts(bundle('a'), bundle('b', { configure })).recordedConfigurationComparable, false)
  }
  assert.equal(compareEvaluationReceipts(bundle('a'), bundle('a')).recordedConfigurationComparable, false)
  const b = bundle('b'); for (const row of b.results) { const { id, ...p } = row.budget.profiles[0]; row.budget.profiles = [seal({ ...p, scopeHash: '5'.repeat(64) })] }
  assert.ok(compareEvaluationReceipts(bundle('a'), b).reasons.includes('credential_endpoint_role_scope_changed_or_missing'))
})

test('versions, duplicate cases, corrupted hashes, false passes and mixed runs are rejected structurally', () => {
  const changes = [b => { b.results.push(b.results[0]) }, b => { b.results[0].schema = 'unknown' }, b => { b.manifest.tasks[0].taskHash = '0'.repeat(64) },
    b => { b.results[0].configHash = '0'.repeat(64) }, b => { b.results[0].evidence = {} }, b => { b.results[0].candidateHash = 'c'.repeat(64) },
    b => { b.results[0].budget.spentUsd = NaN }, b => { b.results[0].endedAt = 'not-a-date' }, b => { b.context.configuration.profile.apiKey = 'PRIVATE_SECRET_CANARY' },
    b => { b.results[1].evidence.durableRunId = b.results[0].evidence.durableRunId }]
  for (const change of changes) { const b = bundle('b'); change(b); assert.throws(() => compareEvaluationReceipts(bundle('a'), b), error => error.code.startsWith('COMPARE_') && !error.message.includes('PRIVATE_SECRET_CANARY')) }
})

test('a changed oracle fingerprint produces an incomparable task set, not an apparent score improvement', () => {
  const a = bundle('a'), b = bundle('b')
  b.manifest.tasks[0].oracleHash = hash('different-oracle')
  const { manifestHash, ...body } = b.manifest
  b.manifest.manifestHash = hash(body)
  for (const row of b.results) row.manifestHash = b.manifest.manifestHash
  const report = compareEvaluationReceipts(a, b)
  assert.equal(report.recordedConfigurationComparable, false)
  assert.ok(report.reasons.includes('task_manifest_changed')); assert.equal(report.paired, null)
})

test('local-free authorization participates in exact config hash while private listener details never leave report', () => {
  const a = bundle('a', { localFree: true }), b = bundle('b', { localFree: true })
  const report = compareEvaluationReceipts(a, b)
  assert.equal(report.recordedConfigurationComparable, true)
  assert.equal(report.left.budget.reservedTokens.observed, 10800000)
  assert.doesNotMatch(JSON.stringify(report), /127\.0\.0\.1|NOT_READ|private\/canary|18999/)
  b.authorization.localFreePolicy.maxRequests++
  assert.throws(() => compareEvaluationReceipts(a, b), { code: 'COMPARE_AUTHORIZATION_INVALID' })
})

async function files(t, value, suffix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `kk-eval-compare-${suffix}-`))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await chmod(directory, 0o700)
  for (const [name, object] of [['manifest.json', value.manifest], ['comparison-context.json', value.context], ...value.results.map(row => [`${row.caseId}-${row.repetition}.json`, row]), ...(value.authorization ? [['authorization.json', value.authorization]] : [])]) await writeFile(path.join(directory, name), JSON.stringify(object), { mode: 0o600 })
  return directory
}

test('actual CLI reads receipts only, does not touch files or echo private paths/endpoint/env data', async t => {
  const left = await files(t, bundle('a'), 'left'), right = await files(t, bundle('b'), 'right')
  const before = await readFile(path.join(left, 'R01-1.json'), 'utf8'), names = await readdir(left)
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/evaluate-compare.mjs', import.meta.url)), '--left', left, '--right', right], { timeout: 15000 })
  assert.equal(JSON.parse(result.stdout).recordedConfigurationComparable, true)
  assert.equal(await readFile(path.join(left, 'R01-1.json'), 'utf8'), before); assert.deepEqual(await readdir(left), names)
  assert.ok(!result.stdout.includes(left)); assert.doesNotMatch(result.stdout, /fixture\.invalid|NOT_READ_BY_COMPARISON/)
})

test('reader rejects symlink, hardlink, broad permissions and record filename mismatch', async t => {
  const original = bundle('a'), root = await files(t, original, 'unsafe')
  const recordFile = path.join(root, 'R01-1.json'), backup = path.join(root, 'saved.bin')
  const bytes = await readFile(recordFile)
  await rm(recordFile); await writeFile(backup, bytes, { mode: 0o600 })
  await link(backup, recordFile)
  await assert.rejects(readEvaluationComparisonBundle(root), { code: 'COMPARE_PRIVATE_FILE_REQUIRED' })
  await rm(recordFile)
  if (process.platform !== 'win32') {
    await symlink(backup, recordFile)
    await assert.rejects(readEvaluationComparisonBundle(root), { code: 'COMPARE_PRIVATE_FILE_REQUIRED' }); await rm(recordFile)
  }
  await writeFile(recordFile, bytes, { mode: 0o600 })
  if (process.platform !== 'win32') { await chmod(recordFile, 0o644); await assert.rejects(readEvaluationComparisonBundle(root), { code: 'COMPARE_PRIVATE_FILE_REQUIRED' }); await chmod(recordFile, 0o600) }
  await writeFile(recordFile, JSON.stringify({ ...original.results[0], repetition: 2 }))
  await assert.rejects(readEvaluationComparisonBundle(root), { code: 'COMPARE_FILENAME_BINDING' })
})

test('CLI exits 2 for incomplete comparison and 1 for corrupt input without leaking private parse context', async t => {
  const a = await files(t, bundle('a'), 'exit-left'), b = await files(t, bundle('b'), 'exit-right')
  const cli = fileURLToPath(new URL('../scripts/evaluate-compare.mjs', import.meta.url))
  await rm(path.join(b, 'R01-1.json'))
  await assert.rejects(promisify(execFile)(process.execPath, [cli, '--left', a, '--right', b]), error => {
    const report = JSON.parse(error.stdout)
    assert.equal(error.code, 2); assert.equal(report.right.denominator, 120); assert.equal(report.right.statuses.missing, 1)
    return true
  })
  await writeFile(path.join(b, 'R01-1.json'), '{ PRIVATE_PARSE_CANARY', { mode: 0o600 })
  await assert.rejects(promisify(execFile)(process.execPath, [cli, '--left', a, '--right', b]), error => {
    assert.equal(error.code, 1); assert.doesNotMatch(error.stdout, /PRIVATE_PARSE_CANARY/); assert.ok(!error.stdout.includes(b))
    return true
  })
})
