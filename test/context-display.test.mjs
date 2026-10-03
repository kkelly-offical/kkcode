import test from 'node:test'
import assert from 'node:assert/strict'
import { contextDisplay } from '../src/kernel/session/context-display.mjs'

test('latest measured request stays stable while fresh admission budget remains independent', () => {
  const fresh = {tokens: 150000, limit: 120000, source: 'estimated', outputReserved: 10000, inputBudget: 110000, requiredTokens: 160000, provider: 'p', model: 'm'}
  const measured = {...fresh, source: 'provider-usage', tokens: 80000, requiredTokens: 90000, updatedAt: 123}
  assert.equal(contextDisplay(fresh, measured).tokens, 80000)
  assert.equal(contextDisplay(fresh, measured).updatedAt, 123)
  assert.ok(fresh.requiredTokens > fresh.limit, 'UI stability never relaxes real request admission')
  for(const changed of [{model: 'other'}, {provider: 'other'}, {limit: 200000}, {source: 'count-api'}, {source: 'strict-upper-bound'}]) {
    const current = {...fresh, ...changed}
    assert.equal(contextDisplay(current, measured), current)
  }
  assert.equal(contextDisplay(fresh, null), fresh, 'compaction clears old measured context immediately')
})
