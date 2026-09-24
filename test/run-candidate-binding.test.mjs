import test from 'node:test'
import assert from 'node:assert/strict'
import { createVerifiedForgeRun } from './helpers/verified-forge-run.mjs'
import { captureAcceptanceCandidate } from '../src/kernel/session/acceptance-manifest.mjs'
import { createRunForgeDelivery } from '../src/sdk/forge.mjs'
import { TOKEN } from './helpers/forge-http.mjs'

test('actual accepted candidate binds Git history as well as identical working files before delivery', {
  skip: !process.env.KKCODE_STRICT_TEST_IMAGE, timeout: 120000
}, async t => {
  const f = await createVerifiedForgeRun(t, { image: process.env.KKCODE_STRICT_TEST_IMAGE })
  assert.equal(f.result.verified, true)
  const original = await f.coordinator.verifiedCandidate({ runId: f.run.id })
  const budgetBefore = await f.store.getRunBudget({ runId: f.run.id })
  const paused = await f.coordinator.pause({ runId: f.run.id })
  await assert.rejects(f.coordinator.resumeDelivery({ runId: f.run.id, expectedRevision: paused.revision - 1 }), { code: 'REVISION_CONFLICT' })
  const resumed = await f.coordinator.resumeDelivery({ runId: f.run.id, expectedRevision: paused.revision })
  assert.equal(resumed.state, 'waiting_input')
  assert.deepEqual(await f.store.getRunBudget({ runId: f.run.id }), budgetBefore, 'resuming delivery does not execute a model or reconfigure its budget')
  const tree = (await f.git(['rev-parse', 'HEAD^{tree}'], f.cwd)).stdout.trim()
  const changed = (await f.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-p', original.candidate.head, '-m', 'Unverified history with unchanged files'], f.cwd)).stdout.trim()
  await f.git(['update-ref', 'HEAD', changed, original.candidate.head], f.cwd)
  const current = await captureAcceptanceCandidate(f.cwd)
  assert.equal(current.treeFingerprint, original.candidate.treeFingerprint)
  assert.notEqual(current.head, original.candidate.head)
  await assert.rejects(f.coordinator.verifiedCandidate({ runId: f.run.id }), { code: 'STALE_CANDIDATE' })
  await assert.rejects(f.coordinator.complete({ runId: f.run.id }), { code: 'STALE_CANDIDATE' })
  await assert.rejects(createRunForgeDelivery({ coordinator: f.coordinator, runId: f.run.id, repository: f.repository, token: TOKEN,
    sourceBranch: 'kk/verified', targetBranch: 'main', targetSha: f.targetSha, allowPrivate: true, authorizeDelivery: async () => true }), { code: 'STALE_CANDIDATE' })
  assert.equal(f.requests.filter(request => request.path.includes('git-receive-pack')).length, 0)
})
