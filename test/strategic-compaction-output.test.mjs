import test from 'node:test'
import assert from 'node:assert/strict'
import hook from '../src/kernel/plugin/builtin-hooks/strategic-compaction.mjs'

test('built-in compaction compatibility hook never rewrites actual command bytes or shares counters across sessions', async () => {
  for (let i = 0; i < 95; i++) {
    const result = i % 2 ? 'unchanged captured bytes\n' : {output: 'unchanged captured bytes\n', metadata: {exitCode: 0}}
    const payload = {sessionId: i % 2 ? 'one' : 'another', toolName: 'bash', result}
    const observed = await hook.tool.after(payload)
    assert.equal(observed, payload)
    assert.equal(observed.result, result)
    assert.deepEqual(observed.result, i % 2 ? 'unchanged captured bytes\n' : {output: 'unchanged captured bytes\n', metadata: {exitCode: 0}})
  }
})
