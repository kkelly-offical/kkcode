import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { createArtifactStore } from '../src/storage/artifact-store.mjs'
import { verifyRunHostBinding } from '../src/sdk/runs.mjs'
import { normalizeRunHostBinding } from '../src/kernel/orchestration/run-host-binding.mjs'
import { runHostBindingHash } from '../src/commands/run-host-binding.mjs'

const first = 'a'.repeat(64), second = 'b'.repeat(64)
async function fixture(t, approval) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-host-binding-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const artifacts = createArtifactStore({ root }), actor = { accountId: 'binding-account', projectId: 'binding-project', sessionId: 'binding-session', runId: 'binding-run' }
  const stored = await artifacts.put({ actor, content: JSON.stringify(approval), mime: 'application/json', source: { kind: 'system' } })
  return { artifacts, run: { id: actor.runId, binding: { ...actor, cwd: root, contractApprovalRef: stored.id } } }
}

test('bound original approval rejects null, missing and different SDK host binding without fallback', async t => {
  const f = await fixture(t, { schema: 'kk.run-contract-approval.v1', hostBindingHash: first })
  assert.deepEqual(await verifyRunHostBinding({ ...f, hostBindingHash: first }), { verified: true, hostBindingHash: first })
  for (const hostBindingHash of [null, undefined, second]) await assert.rejects(verifyRunHostBinding({ ...f, hostBindingHash }), { code: 'HOST_BINDING_CHANGED' })
  await assert.rejects(verifyRunHostBinding(f), { code: 'HOST_BINDING_CHANGED' })
  for (const invalid of ['', 'A'.repeat(64), true, {}, { approved: true }, 0]) assert.throws(() => normalizeRunHostBinding(invalid), { code: 'HOST_BINDING_INVALID' })
})

test('legacy null binding stays null and cannot silently acquire a CLI binding', async t => {
  for (const original of [{}, { hostBindingHash: null }]) {
    const f = await fixture(t, { schema: 'kk.run-contract-approval.v1', ...original })
    assert.deepEqual(await verifyRunHostBinding(f), { verified: true, hostBindingHash: null })
    await assert.rejects(verifyRunHostBinding({ ...f, hostBindingHash: first }), { code: 'HOST_BINDING_CHANGED' })
  }
  const run = { id: 'legacy', binding: {} }
  assert.deepEqual(await verifyRunHostBinding({ run, artifacts: null }), { verified: true, hostBindingHash: null })
  await assert.rejects(verifyRunHostBinding({ run, artifacts: null, hostBindingHash: first }), { code: 'HOST_BINDING_CHANGED' })
})

test('host binding reads the complete scoped original artifact and rejects another principal or schema', async t => {
  const f = await fixture(t, { schema: 'kk.run-contract-approval.v1', explanation: 'x'.repeat(350000), hostBindingHash: first })
  assert.equal((await verifyRunHostBinding({ ...f, hostBindingHash: first })).verified, true)
  await assert.rejects(verifyRunHostBinding({ ...f, run: { ...f.run, binding: { ...f.run.binding, accountId: 'wrong-account' } }, hostBindingHash: first }))
  const wrong = await fixture(t, { schema: 'model-says-approved', hostBindingHash: first })
  await assert.rejects(verifyRunHostBinding({ ...wrong, hostBindingHash: first }), { code: 'HOST_BINDING_CHANGED' })
})

test('CLI host hash canonically freezes execution fields but ignores display and observation revisions', () => {
  const meta = { sourceCwd: '/source', workspace: '/task', baseRevision: '1'.repeat(40), image: `sha256:${first}`,
    acceptance: { required: true, goal: { criteria: [{ id: 'test', spec: { command: 'node', args: ['test.mjs'] } }] } },
    networkOrigins: ['https://example.invalid'], taskGraph: { budgetUsd: 1, deadlineAt: 123, maxConcurrency: 1 },
    limits: { budgetUsd: 2, deadlineAt: 234 }, actor: { accountId: 'account', projectId: 'project' },
    dependencyEnvironment: { directory: '/private/npm-env', planId: first, treeHash: second } }
  const original = runHostBindingHash(meta)
  assert.equal(original, runHostBindingHash(Object.fromEntries(Object.entries(meta).reverse())))
  assert.equal(original, runHostBindingHash({ ...meta, confirmation: 'new-display-hash', observed: { revision: 9, ownerEpoch: 3 }, runId: 'same-real-ledger-scope-is-separately-checked' }))
  for (const key of Object.keys(meta)) {
    const absent = { ...meta }; delete absent[key]
    assert.notEqual(original, runHostBindingHash(absent), `missing ${key} must not preserve original authority`)
    assert.notEqual(original, runHostBindingHash({ ...meta, [key]: null }), `null ${key} must not preserve original authority`)
  }
  assert.notEqual(original, runHostBindingHash({ ...meta, sourceCwd: '/other-source' }))
  assert.notEqual(original, runHostBindingHash({ ...meta, dependencyEnvironment: { ...meta.dependencyEnvironment, treeHash: first } }))
})
