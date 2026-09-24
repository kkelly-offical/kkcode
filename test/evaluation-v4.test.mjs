import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cases as v3, createManifest as manifest3 } from '../evaluation/v3/manifest.mjs'
import { createManifest as manifest1 } from '../evaluation/v1/manifest.mjs'
import { createManifest as manifest2 } from '../evaluation/v2/manifest.mjs'
import { cases, createManifest, correctedIds, sha256 } from '../evaluation/v4/manifest.mjs'

test('v4 changes only development C04/C10 and preserves all historical catalog hashes', () => {
  assert.equal(manifest1().manifestHash, '847034ca90e740d0687f14feb5a657c93a10f1d246b360d7492fe6869ac97bb6')
  assert.equal(manifest2().manifestHash, '84beb0c4f6607fc08bd57c4e16324b05186b2b51392c2aabbf539c67fa4ce1f3')
  assert.equal(manifest3().manifestHash, 'ef356a4ea20d373bd8a33eb6e2c4c43b673ffaaf767b4374c03ae8aecd9acc88')
  assert.deepEqual(correctedIds, ['C04', 'C10'])
  for (let index = 0; index < cases.length; index++) {
    if (correctedIds.includes(cases[index].id)) continue
    assert.equal(cases[index], v3[index], 'other task objects must be passed through unchanged, including sealed tasks')
  }
  const task = cases.find(item => item.id === 'C04'), prior = v3.find(item => item.id === 'C04')
  assert.equal(task.split, 'development')
  assert.equal(task.counterReplayCheck, 'bound-counter-v4')
  for (const key of ['expectedResult', 'requiredEvidence', 'stages', 'resultMatch', 'outputSchema']) assert.equal(task[key], prior[key])
  assert.notEqual(sha256(task), sha256(prior))
  assert.equal(createManifest().suite, 'kkcode-1.0.5-60-v4')
  assert.equal(createManifest().graderRevision, 4)
  assert.equal(Object.hasOwn(manifest3(), 'graderRevision'), false)
  const receiptTask = cases.find(item => item.id === 'C10'), oldReceipt = v3.find(item => item.id === 'C10')
  assert.equal(receiptTask.split, 'development')
  assert.equal(receiptTask.receiptReplayCheck, 'bound-effect-receipt-v4')
  for (const key of ['expectedResult', 'requiredEvidence', 'stages', 'lifecycle']) assert.equal(receiptTask[key], oldReceipt[key])
})

test('evaluation CLI selects v4 without changing the historical default', async () => {
  const exec = promisify(execFile)
  const result = await exec(process.execPath, ['scripts/evaluate.mjs', 'list', '--suite-version', 'v4'])
  assert.equal(JSON.parse(result.stdout).suite, 'kkcode-1.0.5-60-v4')
  const original = await exec(process.execPath, ['scripts/evaluate.mjs', 'list'])
  assert.equal(JSON.parse(original.stdout).manifestHash, manifest1().manifestHash)
})
