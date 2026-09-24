import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRunForgeDelivery, createForgeReconciler } from '../src/sdk/forge.mjs'
import { createVerifiedForgeRun } from './helpers/verified-forge-run.mjs'
import { TOKEN } from './helpers/forge-http.mjs'

for (const kind of ['github', 'gitlab']) test(`${kind}: real Ultra acceptance, durable intents, Git HTTP push and draft delivery`, {
  skip: !process.env.KKCODE_STRICT_TEST_IMAGE, timeout: 120000
}, async t => {
  const f = await createVerifiedForgeRun(t, { kind, image: process.env.KKCODE_STRICT_TEST_IMAGE })
  assert.equal(f.result.verified, true, JSON.stringify(f.result.turn))
  const actual = await f.coordinator.verifiedCandidate({ runId: f.run.id })
  assert.equal(actual.run.candidateHash.length, 64)
  assert.equal(await readFile(path.join(f.cwd, 'app.txt'), 'utf8'), 'verified candidate from kernel\n')
  const suppliedRepository = structuredClone(f.repository), suppliedChecks = [{ kind: kind === 'github' ? 'check_run' : 'job', name: 'test' }]
  const preparing = createRunForgeDelivery({ coordinator: f.coordinator, runId: f.run.id, repository: suppliedRepository, token: TOKEN,
    sourceBranch: 'kk/verified', targetBranch: 'main', targetSha: f.targetSha, allowPrivate: true,
    requiredChecks: suppliedChecks, authorizeDelivery: async () => true })
  suppliedRepository.remote = 'https://unapproved.invalid/other/repo.git'
  suppliedChecks.length = 0
  const service = await preparing
  assert.equal(service.delivery.contract.requiredChecks.length, 1)
  t.after(() => service.close())
  assert.notEqual(service.binding.candidateSha, f.targetSha)
  const pushed = await service.delivery.pushCandidate({ actionId: 'test-push-one' })
  assert.equal(pushed.status, 'succeeded', JSON.stringify(pushed))
  const draft = await service.delivery.openDraft({ actionId: 'test-draft-one', title: 'Verified local fixture', body: 'Original tests passed in the actual strict runtime.' })
  assert.equal(draft.status, 'succeeded', JSON.stringify(draft))
  const replay = await service.delivery.openDraft({ actionId: 'test-draft-one', title: 'Verified local fixture', body: 'Original tests passed in the actual strict runtime.' })
  assert.equal(replay.status, 'succeeded'); assert.equal(replay.reconciled, true)
  assert.equal(f.effects.filter(effect => effect.operation === 'draft').length, 1)
  const persisted = await f.store.getRun(f.run.id)
  assert.deepEqual(persisted.actions.filter(action => action.kind.startsWith('forge.')).map(action => action.state), ['succeeded', 'succeeded'])
  await writeFile(path.join(f.cwd, 'app.txt'), 'changed after acceptance')
  await assert.rejects(service.delivery.updateDraft({ actionId: 'stale-update', number: 1, title: 'must not send', body: 'no' }), /变化|STALE_CANDIDATE/)
  assert.equal(f.effects.filter(effect => effect.operation === 'update').length, 0)
  await writeFile(path.join(f.cwd, 'app.txt'), 'verified candidate from kernel\n')
  let confirmations = 0
  const racing = await createRunForgeDelivery({ coordinator: f.coordinator, runId: f.run.id, repository: f.repository, token: TOKEN,
    sourceBranch: 'kk/verified', targetBranch: 'main', targetSha: f.targetSha, candidateSha: service.binding.candidateSha, allowPrivate: true,
    authorizeDelivery: async () => { if (++confirmations === 2) await writeFile(path.join(f.cwd, 'app.txt'), 'changed during second approval'); return true } })
  t.after(() => racing.close())
  await assert.rejects(racing.delivery.updateDraft({ actionId: 'approval-race', number: 1, title: 'must not send', body: 'no' }), /变化|STALE_CANDIDATE/)
  assert.equal((await f.store.getRun(f.run.id)).actions.find(action => action.id === 'approval-race').state, 'not_applied')
  assert.equal(f.effects.filter(effect => effect.operation === 'update').length, 0)
  await writeFile(path.join(f.cwd, 'app.txt'), 'verified candidate from kernel\n')
  f.hideAfterUpdate()
  const uncertainRequest = { actionId: 'lost-update', number: 1, title: 'Actually applied', body: 'Reply was lost' }
  assert.equal((await service.delivery.updateDraft(uncertainRequest)).status, 'unknown')
  await f.coordinator.cancel({ runId: f.run.id })
  await writeFile(path.join(f.cwd, 'app.txt'), 'local edits after cancelled delivery')
  await f.git(['update-ref', 'refs/heads/main', service.binding.candidateSha], f.remote)
  f.reveal()
  const reconciler = createForgeReconciler({ client: service.delivery.client, contract: service.delivery.contract, actions: f.coordinator.actionAdapter(f.run.id) })
  const approvals = f.authorizationRequests.length, effects = f.effects.length
  await assert.rejects(reconciler.reconcile({ operation: 'update', request: { ...uncertainRequest, body: 'different operation' } }), { code: 'ACTION_CONFLICT' })
  const observation = { ...uncertainRequest }
  const observing = reconciler.reconcile({ operation: 'update', request: observation })
  observation.number = 999; observation.body = 'mutated after lookup'
  const reconciled = await observing
  assert.equal(reconciled.status, 'succeeded'); assert.equal(reconciled.readOnly, true); assert.equal(reconciled.requiresReverification, true)
  const immutable = (await f.store.getRun(f.run.id)).actions.find(action => action.id === uncertainRequest.actionId).receipt
  assert.equal((await reconciler.reconcile({ operation: 'update', request: uncertainRequest })).status, 'succeeded')
  assert.deepEqual((await f.store.getRun(f.run.id)).actions.find(action => action.id === uncertainRequest.actionId).receipt, immutable, 'success receipt cannot be overwritten by another observation')
  assert.equal((await f.store.getRun(f.run.id)).state, 'cancelled', 'read-only reconciliation cannot revive the cancelled task')
  assert.equal(f.authorizationRequests.length, approvals, 'no new write grant is requested')
  assert.equal(f.effects.length, effects, 'no external action is replayed')
  await f.coordinator.close() // No prepared external lease may survive refusal.
})
