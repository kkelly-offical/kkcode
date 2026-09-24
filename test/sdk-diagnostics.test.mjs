import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { openRunStore } from '../src/storage/run-store.mjs'
import { diagnoseRun } from '../src/sdk/diagnostics.mjs'
import { budgetProfileId } from '../src/storage/run-budget-profile.mjs'
test('SDK diagnosis uses actual current receipts, distinguishes unknown effects/billing and omits private content', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kk-diagnose-')), store = await openRunStore({ directory })
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }) })
  let run = await store.createRun({ id: 'diagnostic', ownerId: 'PRIVATE_OWNER', contract: { objective: 'PRIVATE_OBJECTIVE', requiredCriteria: [{ id: 'tests', description: 'PRIVATE_CRITERION' }] } })
  const guard = () => ({ runId: run.id, expectedRevision: run.revision, ownerId: run.ownerId, ownerEpoch: run.ownerEpoch })
  let diagnosis = await diagnoseRun({ store, runId: run.id })
  assert.deepEqual(diagnosis.blockers.map(value => value.code), ['budget_missing', 'candidate_missing', 'verification_incomplete'])
  const profile = { version: 1, provider: 'PRIVATE_PROVIDER', model: 'PRIVATE_MODEL', protocol: 'openai', scopeHash: 'd'.repeat(64), contextLimit: 1024, maxTokens: 128, compaction: false, rates: { input: 0.000001, output: 0.000002, cacheRead: 0.000001, cacheWrite: 0.000001 }, source: 'manual' }
  profile.id = budgetProfileId(profile)
  await store.configureRunBudget({ ...guard(), budgetUsd: 2, deadlineAt: Date.now() + 60000, profiles: [profile], approval: { approved: true, actorId: 'PRIVATE_ACTOR', reason: 'PRIVATE_GRANT' } })
  run = await store.getRun(run.id)
  await store.reserveModelBudget({ ...guard(), requestId: 'PRIVATE_REQUEST', amountUsd: 1, provider: 'PRIVATE_PROVIDER', model: 'PRIVATE_MODEL', profileId: profile.id })
  run = await store.getRun(run.id)
  await store.settleModelBudget({ ...guard(), requestId: 'PRIVATE_REQUEST', amountUsd: null, status: 'unknown' })
  run = await store.getRun(run.id)
  run = await store.setCandidate({ ...guard(), candidateHash: 'a'.repeat(64) })
  run = await store.recordVerification({ ...guard(), receipt: { id: 'receipt', candidateHash: run.candidateHash, criterionId: 'tests', status: 'passed', evidenceRefs: ['PRIVATE_EVIDENCE'] } })
  run = await store.prepareAction({ ...guard(), action: { id: 'PRIVATE_ACTION', kind: 'publish', target: 'PRIVATE_TARGET', parameterHash: 'b'.repeat(64), effect: 'external_write', retryPolicy: 'never' } })
  diagnosis = await diagnoseRun({ store, runId: run.id })
  assert.deepEqual(diagnosis.blockers.map(value => value.code), ['effects_unresolved', 'billing_unknown'])
  assert.equal(JSON.stringify(diagnosis).includes('PRIVATE_'), false)
  run = await store.setCandidate({ ...guard(), candidateHash: 'c'.repeat(64) })
  assert.equal((await diagnoseRun({ store, runId: run.id })).criteria[0].status, 'unknown', 'old passing receipts never validate a new candidate')
})
