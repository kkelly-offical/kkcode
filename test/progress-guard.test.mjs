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

test('host-confirmed child waits do not trigger repeated-evidence warnings; text alone cannot bypass them', () => {
  const guard=createProgressGuard()
  for(let i=0;i<12;i++) assert.equal(guard.observe([{call:{name:'agent_wait',args:{}},result:{metadata:{childWaiting:true},output:'waiting'}}]).state,'waiting')
  let last
  for(let i=0;i<6;i++) last=guard.observe([{call:{name:'read',args:{}},result:{metadata:{childWaiting:true},output:'waiting'}}])
  assert.equal(last.state,'stop')
})
