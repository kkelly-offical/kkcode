import test from 'node:test'
import assert from 'node:assert/strict'
import { runSerialBatch, stopReason } from '../evaluation/overnight/serial-batch.mjs'
const clean = { controllerExit: 0, cleanupKnown: true, usageUnknown: 0, toolUnknown: 0, state: 'automatic_checks_passed_manual_pending' }

test('cases never overlap, and an ordinary delivery failure does not stop the next case', async () => {
  let active = 0, peak = 0
  const order = []
  const result = await runSerialBatch({ sequence: ['first', 'second'], before: async id => order.push('before:' + id), save: async () => {}, execute: async id => {
    peak = Math.max(peak, ++active); order.push('start:' + id)
    await new Promise(resolve => setTimeout(resolve, 5))
    order.push('cleanup:' + id); active--
    return { ...clean, state: id === 'first' ? 'failed' : clean.state }
  } })
  assert.equal(peak, 1)
  assert.deepEqual(order, ['before:first', 'start:first', 'cleanup:first', 'before:second', 'start:second', 'cleanup:second'])
  assert.equal(result.results[0].state, 'failed')
  assert.deepEqual(result.notRun, [])
})

test('unknown model usage, unknown effects and uncertain cleanup stop without retries', async () => {
  for (const patch of [{ usageUnknown: 1 }, { toolUnknown: 1 }, { cleanupKnown: false }, { controllerExit: 2 }, { state: 'environment_blocked' }, { native: { completion: { verification: { state: 'outcome_unknown' } } } }]) {
    let calls = 0
    const result = await runSerialBatch({ sequence: ['one', 'two'], before: async () => {}, save: async () => {}, execute: async () => { calls++; return { ...clean, ...patch } } })
    assert.equal(calls, 1); assert.equal(result.status, 'stopped'); assert.deepEqual(result.notRun, ['two'])
  }
})

test('stop request prevents dispatch and no missing evidence is treated as success', async () => {
  const result = await runSerialBatch({ sequence: ['one'], stopRequested: () => true, before: async () => assert.fail(), execute: async () => assert.fail(), save: async () => {} })
  assert.deepEqual(result.notRun, ['one'])
  assert.equal(stopReason({ controllerExit: 0 }), 'cleanup_not_proven')
})
