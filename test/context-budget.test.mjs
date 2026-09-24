import test from 'node:test'
import assert from 'node:assert/strict'
import { requestContextBudget } from '../src/kernel/session/context-budget.mjs'
import { shouldCompact } from '../src/kernel/session/compaction.mjs'
import { publicContext } from '../src/protocol/context.mjs'

const configState = { config: { provider: { default: 'local', local: { context_limit: 64000, max_tokens: 4096 } } } }
test('fallback includes system, schemas, history and output reservation', () => {
  const messages = [{ role: 'user', content: 'x'.repeat(120000) }]
  const meter = requestContextBudget({ system: 'x'.repeat(72000), messages, tools: [{ name: 'tool', description: 'x'.repeat(34000) }], model: 'local-model', configState })
  assert.ok(meter.tokens > 56000)
  assert.equal(meter.outputReserved, 4096)
  assert.equal(meter.estimated, true)
  assert.equal(shouldCompact({ messages, model: 'local-model', configState, realTokenCount: meter.requiredTokens }), true)
})
test('remote counts and usage do not add estimated blocks a second time', () => {
  for (const source of ['count-api', 'provider-usage']) {
    const meter = requestContextBudget({ system: 'large'.repeat(10000), model: 'm', configState, measuredTokens: 1000, source })
    assert.equal(meter.tokens, 1000)
    assert.equal(meter.estimated, false)
    assert.equal(meter.source, source)
  }
})
test('small model windows reserve a bounded default output and invalid counts fall back', () => {
  const meter = requestContextBudget({ system: 'hello', model: 'm', configState: { config: { provider: { default: 'p', p: { context_limit: 4096 } } } }, measuredTokens: NaN })
  assert.equal(meter.outputReserved, 1024)
  assert.equal(meter.inputBudget, 3072)
  assert.equal(meter.estimated, true)
})

test('strict complete-input upper bounds remain explicitly estimated in every client projection', () => {
  const meter = requestContextBudget({ model: 'm', configState, measuredTokens: 60000, source: 'strict-upper-bound' })
  assert.equal(meter.source, 'strict-upper-bound')
  assert.equal(meter.estimated, true)
  assert.equal(meter.tokens, 60000)
  const projected = publicContext({ ...meter, privatePrompt: 'must not be projected' })
  assert.equal(projected.source, 'strict-upper-bound')
  assert.equal(projected.estimated, true)
  assert.equal(projected.tokens, 60000)
  assert.equal('privatePrompt' in projected, false)
})
