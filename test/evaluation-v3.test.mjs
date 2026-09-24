import test from 'node:test'
import assert from 'node:assert/strict'
import { cases as v1, createManifest as manifest1 } from '../evaluation/v1/manifest.mjs'
import { cases as v2, createManifest as manifest2 } from '../evaluation/v2/manifest.mjs'
import { cases, correctedIds, immutableInputIds, createManifest, sha256 } from '../evaluation/v3/manifest.mjs'

test('v3 contract audit preserves both historical manifests and every sealed task', () => {
  assert.equal(manifest1().manifestHash, '847034ca90e740d0687f14feb5a657c93a10f1d246b360d7492fe6869ac97bb6')
  assert.equal(manifest2().manifestHash, '84beb0c4f6607fc08bd57c4e16324b05186b2b51392c2aabbf539c67fa4ce1f3')
  assert.equal(cases.length, 60)
  assert.equal(cases.filter(task => task.split === 'development').length, 40)
  assert.equal(cases.filter(task => task.split === 'sealed').length, 20)
  assert.deepEqual(cases.filter((task, index) => sha256(task) !== sha256(v2[index])).map(task => task.id).sort(), [...correctedIds].sort())
  for (const task of cases.filter(task => task.split === 'sealed')) {
    assert.equal(task, v2.find(previous => previous.id === task.id))
    assert.equal(task, v1.find(previous => previous.id === task.id))
  }
  assert.equal(createManifest().suite, 'kkcode-1.0.5-60-v3')
})

test('v3 changes only visible declarations and never algorithm expectations or safety/recovery conditions', () => {
  for (const task of cases) {
    const prior = v2.find(item => item.id === task.id)
    for (const key of ['expectedResult', 'probes', 'oracle', 'referenceFiles', 'referenceOperations', 'setupOperations', 'requiredEvidence', 'resultMatch', 'protocolReplayCheck', 'lifecycle', 'critical', 'split']) {
      assert.deepEqual(task[key], prior[key], `${task.id}: ${key}`)
    }
  }
  for (const id of immutableInputIds) {
    const task = cases.find(item => item.id === id)
    assert.match(task.prompt, /不得修改传入的 input/)
    assert.match(task.fixtureFiles['CONTRACT.md'], /不得修改传入的 input/)
  }
  assert.match(cases.find(task => task.id === 'R06').prompt, /从 0 开始[\s\S]*半开区间 \[start,end\)/)
})

test('development output contracts expose root location, exact keys and actual final-stage timing', () => {
  const keys = { C01: ['timezone', 'publish'], C02: ['directory', 'overwrite'], C07: ['label'] }
  for (const [id, fields] of Object.entries(keys)) {
    const task = cases.find(item => item.id === id)
    assert.deepEqual(task.outputSchema.required, fields)
    assert.equal(task.outputSchema.additionalProperties, false)
    assert.match(task.prompt, /工作区根目录的 result.json/)
    assert.match(task.stages[1].prompt, /当前是最终阶段，必须完成/)
    assert.match(task.fixtureFiles['CONTRACT.md'], /不是项目交付物/)
  }
  for (const id of ['C04', 'C05', 'C06']) {
    const task = cases.find(item => item.id === id)
    assert.doesNotMatch(task.stages[1].prompt, /当前阶段不必提前/)
    assert.match(task.stages[1].prompt, /当前是最终阶段，必须完成/)
  }
})
