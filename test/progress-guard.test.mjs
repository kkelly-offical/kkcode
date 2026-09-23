import test from 'node:test'
import assert from 'node:assert/strict'
import { createProgressGuard } from '../src/kernel/session/progress-guard.mjs'
const result = output => [{ call: { name: 'read', args: { path: 'progress.log' } }, result: { status: 'completed', output } }]
test('identical evidence warns at three and stops at six; changing output never trips the guard', () => {
  const guard = createProgressGuard()
  assert.equal(guard.observe(result('same')).state, 'progress')
  guard.observe(result('same'))
  assert.equal(guard.observe(result('same')).state, 'warn')
  guard.observe(result('same')); guard.observe(result('same'))
  assert.equal(guard.observe(result('same')).state, 'stop')
  const polling = createProgressGuard()
  for (let index = 0; index < 300; index++) assert.equal(polling.observe(result(String(index))).state, 'progress')
})
test('short alternating dead-end cycles cannot evade no-progress detection', () => {
  const guard = createProgressGuard()
  let last
  for (let index = 0; index < 12; index++) last = guard.observe(result(String(index % 2)))
  assert.equal(last.state, 'stop'); assert.equal(last.period, 2)
})
