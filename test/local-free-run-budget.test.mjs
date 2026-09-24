import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { openRunStore } from '../src/storage/run-store.mjs'
import { budgetProfileId, normalizeBudgetProfile } from '../src/storage/run-budget-profile.mjs'
import { localFreePolicyId, normalizeLocalFreePolicy } from '../src/storage/local-free-policy.mjs'

const approval = { approved: true, actorId: 'local-host', reason: 'Explicit local fixture only; finite inference authority' }
const profileBody = { version: 1, provider: 'local-fixture', model: 'local-model', protocol: 'openai', scopeHash: 'c'.repeat(64), contextLimit: 1000,
  maxTokens: 100, compaction: false, rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, source: 'manual' }
const makeProfile = body => normalizeBudgetProfile({ ...body, id: budgetProfileId(body) })
const profile = makeProfile(profileBody)
// Deliberately synthetic storage metadata, not a branded host grant. Runtime
// authority and actual listener/process identity are tested in the host layer.
const policyBody = { version: 1, provider: profile.provider, model: profile.model, protocol: profile.protocol, scopeHash: profile.scopeHash,
  baseUrl: 'http://127.0.0.1:18299/v1', maxRequests: 3, maxTokens: 500,
  listener: { pid: 123, uid: 1000, fd: 7, inode: '98765', startTimeTicks: '123456', executable: '/fixture/python' } }
const makePolicy = body => normalizeLocalFreePolicy({ ...body, id: localFreePolicyId(body) })
const policy = makePolicy(policyBody)
const guard = run => ({ runId: run.id, expectedRevision: run.revision, ownerId: run.ownerId, ownerEpoch: run.ownerEpoch })
async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kk-free-budget-')), stores = []
  t.after(async () => { await Promise.all(stores.map(store => store.close())); await rm(directory, { recursive: true, force: true }) })
  async function open() { const store = await openRunStore({ directory }); stores.push(store); return store }
  const store = await open()
  const run = await store.createRun({ id: 'free-run', ownerId: 'original', contract: { objective: 'Bound local inference even when price is zero', requiredCriteria: [] } })
  const current = () => store.getRun(run.id)
  const configure = overrides => store.configureRunBudget({ ...guard(run), budgetUsd: 0, deadlineAt: Date.now() + 60000, profiles: [profile], localFreePolicy: policy, approval, ...overrides })
  return { directory, stores, open, store, run, current, configure }
}
const reservation = (run, requestId, tokenAllowance) => ({ ...guard(run), requestId, amountUsd: 0, provider: profile.provider, model: profile.model, profileId: profile.id, tokenAllowance })

test('local-free policy storage schema is exact and only accepts canonical literal loopback metadata', () => {
  assert.deepEqual(makePolicy(policyBody), policy)
  assert.equal(makePolicy({ ...policyBody, baseUrl: 'https://[::1]:18299/v1' }).baseUrl, 'https://[::1]:18299/v1')
  for (const baseUrl of ['http://localhost:18299/v1', 'http://127.1:18299/v1', 'http://127.0.0.2:18299/v1', 'http://10.0.0.2/v1',
    'https://example.com/v1', 'http://127.0.0.1/v1?token=x', 'http://127.0.0.1/v1?', 'http://127.0.0.1/v1#', 'http://user:secret@127.0.0.1/v1', 'ftp://127.0.0.1/v1']) {
    assert.throws(() => makePolicy({ ...policyBody, baseUrl }), { code: 'INVALID_LOCAL_FREE_POLICY' })
  }
  assert.throws(() => normalizeLocalFreePolicy({ ...policy, maxRequests: 4 }), { code: 'INVALID_LOCAL_FREE_POLICY' })
  assert.throws(() => makePolicy({ ...policyBody, secret: 'not-accepted' }), { code: 'INVALID_INPUT' })
  assert.throws(() => makePolicy({ ...policyBody, listener: { ...policyBody.listener, uid: -1 } }), { code: 'INVALID_INPUT' })
  assert.throws(() => makePolicy({ ...policyBody, maxTokens: 1e10 + 1 }), { code: 'INVALID_INPUT' })
})

test('zero-price metadata alone is not authority and free policy cannot replace paid or wider route profiles', async t => {
  const f = await setup(t)
  for (const overrides of [{ approval: { ...approval, approved: false } }, { budgetUsd: 1 }, { profiles: [] },
    { profiles: [makeProfile({ ...profileBody, rates: { ...profileBody.rates, input: 0.001 } })] },
    { profiles: [makeProfile({ ...profileBody, scopeHash: 'd'.repeat(64) })] },
    { profiles: [profile, makeProfile({ ...profileBody, scopeHash: 'd'.repeat(64), model: 'second' })] }]) {
    await assert.rejects(f.configure(overrides), error => ['APPROVAL_REQUIRED', 'INVALID_LOCAL_FREE_POLICY'].includes(error.code))
  }
  await f.configure({ localFreePolicy: undefined })
  const run = await f.current(), budget = await f.store.getRunBudget({ runId: run.id })
  assert.equal(Object.hasOwn(budget, 'localFreePolicy'), false)
  await assert.rejects(f.store.reserveModelBudget(reservation(run, 'unapproved-free', 50)), { code: 'INVALID_INPUT' })
  const { tokenAllowance: _omit, ...ordinary } = reservation(run, 'ordinary-zero', 50)
  await assert.rejects(f.store.reserveModelBudget(ordinary), { code: 'TASK_BUDGET_INSUFFICIENT' })
})

test('free reservations retain cumulative token allowances after settle and reopen, never replaying credit', async t => {
  const f = await setup(t)
  const configured = await f.configure()
  let run = await f.current()
  const first = await f.store.reserveModelBudget(reservation(run, 'first', 200))
  assert.equal(first.fresh, true); assert.equal(first.budget.reservedTokens, 200); assert.equal(first.budget.usedRequests, 1)
  run = await f.current()
  assert.equal((await f.store.reserveModelBudget(reservation(run, 'first', 200))).fresh, false)
  await assert.rejects(f.store.reserveModelBudget(reservation(run, 'first', 199)), { code: 'BUDGET_REQUEST_CONFLICT' })
  await assert.rejects(f.store.reserveModelBudget(reservation(run, 'pending', 100)), { code: 'BUDGET_REQUEST_PENDING' })
  await f.store.settleModelBudget({ ...guard(run), requestId: 'first', status: 'settled', amountUsd: 0 })
  run = await f.current()
  await f.store.reserveModelBudget(reservation(run, 'second', 300))
  run = await f.current()
  await f.store.settleModelBudget({ ...guard(run), requestId: 'second', status: 'settled', amountUsd: 0 })
  await f.store.close()
  const reopened = await f.open(), budget = await reopened.getRunBudget({ runId: run.id })
  assert.deepEqual(budget.localFreePolicy, configured.localFreePolicy)
  assert.equal(budget.spentUsd, 0); assert.equal(budget.reservedUsd, 0); assert.equal(budget.reservedTokens, 500); assert.equal(budget.usedRequests, 2)
  run = await reopened.getRun(run.id)
  assert.equal((await reopened.reserveModelBudget(reservation(run, 'first', 200))).fresh, false)
  await assert.rejects(reopened.reserveModelBudget(reservation(run, 'exhausted', 1)), { code: 'TASK_BUDGET_INSUFFICIENT' })
  await assert.rejects(reopened.configureRunBudget({ ...guard(run), budgetUsd: 0, deadlineAt: configured.deadlineAt, profiles: [profile], localFreePolicy: makePolicy({ ...policyBody, maxTokens: 1000 }), approval }), { code: 'BUDGET_IMMUTABLE' })
})

test('free request count is enforced independently of tokens; no delegation, paid reserve or added scope', async t => {
  const f = await setup(t)
  await f.configure({ localFreePolicy: makePolicy({ ...policyBody, maxRequests: 1 }) })
  let run = await f.current()
  await assert.rejects(f.store.reserveModelBudget({ ...reservation(run, 'delegation', 1), kind: 'delegation', profileId: undefined }), { code: 'INVALID_LOCAL_FREE_POLICY' })
  await assert.rejects(f.store.reserveModelBudget({ ...reservation(run, 'paid', 1), amountUsd: 1e-20 }), { code: 'INVALID_LOCAL_FREE_POLICY' })
  await assert.rejects(f.store.reserveModelBudget({ ...reservation(run, 'missing-tokens', 1), tokenAllowance: undefined }), { code: 'INVALID_INPUT' })
  await assert.rejects(f.store.reserveModelBudget({ ...reservation(run, 'wrong-model', 1), model: 'different' }), { code: 'BUDGET_PROFILE_REQUIRED' })
  await assert.rejects(f.store.approveRunBudgetProfile({ ...guard(run), profile: makeProfile({ ...profileBody, scopeHash: 'd'.repeat(64), model: 'different' }), approval }), { code: 'BUDGET_IMMUTABLE' })
  await f.store.reserveModelBudget(reservation(run, 'one', 1)); run = await f.current()
  await f.store.settleModelBudget({ ...guard(run), requestId: 'one', status: 'settled', amountUsd: 0 }); run = await f.current()
  await assert.rejects(f.store.reserveModelBudget(reservation(run, 'two', 1)), { code: 'TASK_BUDGET_INSUFFICIENT' })
})

test('zero-dollar in-flight reservation survives actual worker SIGKILL and fences stale ownership', async t => {
  const f = await setup(t)
  await f.configure()
  let run = await f.current()
  await f.store.reserveModelBudget(reservation(run, 'lost-http', 100))
  process.kill(f.store.workerPid, 'SIGKILL')
  await new Promise(resolve => setTimeout(resolve, 20))
  const reopened = await f.open(); run = await reopened.getRun(run.id)
  const stale = run
  assert.equal(run.budget.reservedUsd, 0); assert.equal(run.budget.requests[0].status, 'reserved')
  await assert.rejects(reopened.reserveModelBudget(reservation(run, 'blind-before-claim', 1)), { code: 'BUDGET_REQUEST_PENDING' })
  run = await reopened.claimRun({ runId: run.id, expectedRevision: run.revision, expectedOwnerId: run.ownerId, expectedOwnerEpoch: run.ownerEpoch, ownerId: 'new-host', approval })
  assert.equal(run.budget.unknownUsd, 0); assert.equal(run.budget.requests[0].status, 'unknown'); assert.equal(run.budget.reservedTokens, 100)
  await assert.rejects(reopened.reserveModelBudget(reservation(run, 'blind-after-claim', 1)), { code: 'BUDGET_OUTCOME_UNKNOWN' })
  await assert.rejects(reopened.transitionRun({ ...guard(run), state: 'completed' }), { code: 'BUDGET_OUTCOME_UNKNOWN' })
  await assert.rejects(reopened.settleModelBudget({ ...guard(stale), requestId: 'lost-http', amountUsd: 0, status: 'settled' }), { code: 'STALE_OWNER' })
  await assert.rejects(reopened.reconcileModelBudget({ ...guard(run), requestId: 'lost-http', amountUsd: 0, evidenceRefs: [], approval }), { code: 'BUDGET_RECONCILIATION_REQUIRED' })
  await reopened.reconcileModelBudget({ ...guard(run), requestId: 'lost-http', amountUsd: 0, evidenceRefs: ['artifact:host-reconciliation'], approval })
  run = await reopened.getRun(run.id)
  const next = await reopened.reserveModelBudget(reservation(run, 'verified-next', 100))
  assert.equal(next.budget.usedRequests, 2); assert.equal(next.budget.reservedTokens, 200)
})

test('independent SQLite workers cannot race past zero-dollar reservations', async t => {
  const f = await setup(t)
  await f.configure()
  const run = await f.current(), second = await f.open()
  const both = await Promise.allSettled([f.store.reserveModelBudget(reservation(run, 'a', 300)), second.reserveModelBudget(reservation(run, 'b', 300))])
  assert.equal(both.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(both.find(result => result.status === 'rejected').reason.code, 'REVISION_CONFLICT')
  assert.equal((await second.getRunBudget({ runId: run.id })).usedRequests, 1)
})

test('an expired local inference deadline cannot be reset by replaying configuration', async t => {
  const f = await setup(t), deadlineAt = Date.now() + 1000
  await f.configure({ deadlineAt })
  await new Promise(resolve => setTimeout(resolve, Math.max(0, deadlineAt - Date.now()) + 25))
  const run = await f.current()
  await assert.rejects(f.store.reserveModelBudget(reservation(run, 'expired', 1)), { code: 'TASK_DEADLINE' })
  await assert.rejects(f.store.configureRunBudget({ ...guard(run), budgetUsd: 0, deadlineAt: Date.now() + 60000, profiles: [profile], localFreePolicy: policy, approval }), { code: 'BUDGET_IMMUTABLE' })
})

test('any positive charge violates local-free scope even below USD rounding tolerance', async t => {
  const f = await setup(t)
  await f.configure()
  let run = await f.current()
  await f.store.reserveModelBudget(reservation(run, 'not-really-free', 100)); run = await f.current()
  const budget = await f.store.settleModelBudget({ ...guard(run), requestId: 'not-really-free', status: 'settled', amountUsd: 1e-20 })
  assert.equal(budget.requests[0].status, 'unknown'); assert.equal(budget.spentUsd, 0)
  run = await f.current()
  await assert.rejects(f.store.reconcileModelBudget({ ...guard(run), requestId: 'not-really-free', amountUsd: 1e-20, evidenceRefs: ['artifact:bill'], approval }), { code: 'INVALID_LOCAL_FREE_POLICY' })
})
