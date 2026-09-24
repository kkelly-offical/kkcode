import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { openRunStore } from '../src/storage/run-store.mjs'
import { budgetProfileId, normalizeBudgetProfile } from '../src/storage/run-budget-profile.mjs'

const approval = { approved: true, actorId: 'host-user', reason: 'Explicit task budget approval' }
const profileBody = { version: 1, provider: 'fixture', model: 'fixture-model', protocol: 'openai', scopeHash: 'a'.repeat(64), contextLimit: 100,
  maxTokens: 10, compaction: false, rates: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 }, source: 'manual' }
const profile = normalizeBudgetProfile({ ...profileBody, id: budgetProfileId(profileBody) })
const guard = run => ({ runId: run.id, expectedRevision: run.revision, ownerId: run.ownerId, ownerEpoch: run.ownerEpoch })
async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kk-durable-budget-')), stores = []
  t.after(async () => { await Promise.all(stores.map(store => store.close())); await rm(directory, { recursive: true, force: true }) })
  async function open() { const store = await openRunStore({ directory }); stores.push(store); return store }
  const store = await open()
  const run = await store.createRun({ id: 'budget-run', ownerId: 'original', contract: { objective: 'Conserve a real persistent budget', requiredCriteria: [] } })
  return { directory, open, store, run }
}
const reserve = (run, requestId, amountUsd, kind = 'model') => ({ ...guard(run), requestId, amountUsd, provider: kind === 'model' ? 'fixture' : 'kkcode-delegation', model: 'fixture-model', kind, ...(kind === 'model' ? { profileId: profile.id } : {}) })

test('persistent budgets require real confirmation, cannot expand on resume, and atomically constrain parallel workers', async t => {
  const f = await setup(t), deadlineAt = Date.now() + 60000
  await assert.rejects(f.store.configureRunBudget({ ...guard(f.run), budgetUsd: 100, deadlineAt }), { code: 'INVALID_INPUT' })
  await f.store.configureRunBudget({ ...guard(f.run), budgetUsd: 100, deadlineAt, profiles: [profile], approval })
  const run = await f.store.getRun(f.run.id), other = await f.open()
  await assert.rejects(f.store.configureRunBudget({ ...guard(run), budgetUsd: 101, deadlineAt, approval }), { code: 'BUDGET_IMMUTABLE' })
  const parallel = await Promise.allSettled([f.store.reserveModelBudget(reserve(run, 'one', 80)), other.reserveModelBudget(reserve(run, 'two', 80))])
  assert.equal(parallel.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(parallel.find(result => result.status === 'rejected').reason.code, 'REVISION_CONFLICT')
  const current = await f.store.getRun(run.id)
  await assert.rejects(other.reserveModelBudget(reserve(current, 'three', 80)), { code: 'TASK_BUDGET_INSUFFICIENT' })
  assert.equal((await f.store.getRunBudget({ runId: run.id })).reservedUsd, 80)
})

test('pricing evidence is immutable, scope-bound, explicitly approved and required before inference reservation', async t => {
  const f = await setup(t)
  await f.store.configureRunBudget({ ...guard(f.run), budgetUsd: 100, deadlineAt: Date.now() + 60000, approval })
  let run = await f.store.getRun(f.run.id)
  await assert.rejects(f.store.reserveModelBudget(reserve(run, 'missing-price', 1)), { code: 'BUDGET_PROFILE_REQUIRED' })
  await assert.rejects(f.store.approveRunBudgetProfile({ ...guard(run), profile }), { code: 'INVALID_INPUT' })
  await assert.rejects(f.store.approveRunBudgetProfile({ ...guard(run), profile: { ...profile, rates: { ...profile.rates, output: 0 } }, approval }), { code: 'INVALID_BUDGET_PROFILE' })
  await f.store.approveRunBudgetProfile({ ...guard(run), profile, approval }); run = await f.store.getRun(run.id)
  const altered = { ...profileBody, rates: { ...profileBody.rates, output: 0 } }
  await assert.rejects(f.store.approveRunBudgetProfile({ ...guard(run), profile: { ...altered, id: budgetProfileId(altered) }, approval }), { code: 'BUDGET_IMMUTABLE' })
  await assert.rejects(f.store.reserveModelBudget({ ...reserve(run, 'wrong-route', 1), provider: 'other-provider' }), { code: 'BUDGET_PROFILE_REQUIRED' })
  const second = { ...profileBody, scopeHash: 'b'.repeat(64), model: 'different-model' }
  const approved = await f.store.approveRunBudgetProfile({ ...guard(run), profile: { ...second, id: budgetProfileId(second) }, approval })
  assert.equal(approved.profiles.length, 2); assert.equal(approved.profiles[0].rates.output, 2)
  await f.store.close()
  const reopened = await f.open(), saved = await reopened.getRunBudget({ runId: run.id })
  assert.deepEqual(saved.profiles, approved.profiles)
  assert.equal(saved.profiles.some(item => Object.hasOwn(item, 'apiKey') || Object.hasOwn(item, 'baseUrl')), false)
})

test('model and child delegation reservations share the same durable ceiling; stable IDs never replay credit', async t => {
  const f = await setup(t), deadlineAt = Date.now() + 60000
  await f.store.configureRunBudget({ ...guard(f.run), budgetUsd: 100, deadlineAt, profiles: [profile], approval })
  let run = await f.store.getRun(f.run.id)
  const first = await f.store.reserveModelBudget(reserve(run, 'child', 60, 'delegation'))
  assert.equal(first.fresh, true)
  run = await f.store.getRun(run.id)
  assert.equal((await f.store.reserveModelBudget(reserve(run, 'child', 60, 'delegation'))).fresh, false)
  await assert.rejects(f.store.reserveModelBudget(reserve(run, 'child', 50, 'delegation')), { code: 'BUDGET_REQUEST_CONFLICT' })
  await assert.rejects(f.store.reserveModelBudget(reserve(run, 'parent-inference', 50)), { code: 'TASK_BUDGET_INSUFFICIENT' })
  let budget = await f.store.settleModelBudget({ ...guard(run), requestId: 'child', status: 'settled', amountUsd: 20 })
  assert.equal(budget.spentUsd, 20); assert.equal(budget.reservedUsd, 0)
  run = await f.store.getRun(run.id)
  await f.store.reserveModelBudget(reserve(run, 'parent-inference', 80))
  run = await f.store.getRun(run.id)
  budget = await f.store.settleModelBudget({ ...guard(run), requestId: 'parent-inference', status: 'unknown', amountUsd: null })
  assert.equal(budget.unknownUsd, 80); assert.equal(budget.spentUsd, 20)
  run = await f.store.getRun(run.id)
  await assert.rejects(f.store.reserveModelBudget(reserve(run, 'blind-retry', 1)), { code: 'BUDGET_OUTCOME_UNKNOWN' })
  await assert.rejects(f.store.settleModelBudget({ ...guard(run), requestId: 'parent-inference', status: 'settled', amountUsd: 0 }), { code: 'BUDGET_RECONCILIATION_REQUIRED' })
  budget = await f.store.reconcileModelBudget({ ...guard(run), requestId: 'parent-inference', amountUsd: 10, evidenceRefs: ['artifact:verified-billing'], approval })
  assert.equal(budget.unknownUsd, 0); assert.equal(budget.spentUsd, 30)
})

test('actual storage SIGKILL retains reservation; ownership recovery turns it unknown instead of gifting a new budget', async t => {
  const f = await setup(t)
  await f.store.configureRunBudget({ ...guard(f.run), budgetUsd: 100, deadlineAt: Date.now() + 60000, profiles: [profile], approval })
  let run = await f.store.getRun(f.run.id)
  await f.store.reserveModelBudget(reserve(run, 'in-flight', 90))
  process.kill(f.store.workerPid, 'SIGKILL')
  await new Promise(resolve => setTimeout(resolve, 20))
  const reopened = await f.open(); run = await reopened.getRun(run.id)
  assert.equal((await reopened.getRunBudget({ runId: run.id })).reservedUsd, 90)
  run = await reopened.claimRun({ runId: run.id, expectedRevision: run.revision, expectedOwnerId: run.ownerId, expectedOwnerEpoch: run.ownerEpoch, ownerId: 'recovered', approval })
  const budget = await reopened.getRunBudget({ runId: run.id })
  assert.equal(budget.unknownUsd, 90); assert.equal(budget.reservedUsd, 0)
  await assert.rejects(reopened.reserveModelBudget(reserve(run, 'post-restart', 1)), { code: 'BUDGET_OUTCOME_UNKNOWN' })
})

test('cancellation still allows receipt cleanup; a bill exceeding its ceiling remains explicitly unknown', async t => {
  const f = await setup(t)
  await f.store.configureRunBudget({ ...guard(f.run), budgetUsd: 100, deadlineAt: Date.now() + 60000, profiles: [profile], approval })
  let run = await f.store.getRun(f.run.id)
  await f.store.reserveModelBudget(reserve(run, 'overcharge', 50))
  run = await f.store.getRun(run.id); run = await f.store.transitionRun({ ...guard(run), state: 'cancelled' })
  const budget = await f.store.settleModelBudget({ ...guard(run), requestId: 'overcharge', status: 'settled', amountUsd: 110 })
  assert.equal(budget.unknownUsd, 110); assert.equal(budget.spentUsd, 0); assert.equal(budget.requests[0].amountUsd, null)
  const reader = await openRunStore({ directory: f.directory, readOnly: true })
  try { assert.deepEqual(await reader.getRunBudget({ runId: run.id }), budget); await assert.rejects(reader.reserveModelBudget(reserve(run, 'forbidden', 1)), { code: 'READ_ONLY_STORE' }) }
  finally { await reader.close() }
})
