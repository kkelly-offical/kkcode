import test from 'node:test'
import assert from 'node:assert/strict'
import { requestContextBudget } from '../src/kernel/session/context-budget.mjs'
import { attachResponsesState, responsesScope } from '../src/kernel/provider/responses-state.mjs'

const route = { model: 'qwen-fixture', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'fixture-key' }
const configState = { config: { provider: { default: 'fixture', fixture: {
  type: 'openai-responses', default_model: route.model, base_url: route.baseUrl,
  api_key: route.apiKey, context_limit: 262144, max_tokens: 65536
} } } }
function assistant(chars, tokens, encrypted = false) {
  return { role: 'assistant', content: attachResponsesState([
    { type: 'reasoning', text: 'r'.repeat(chars) }, { type: 'text', text: 'Observed next action.' }
  ], { scope: responsesScope(route), reasoningTokens: tokens, items: [
    { type: 'reasoning', id: 'reasoning-fixture', summary: [], ...(encrypted ? { encrypted_content: 'opaque-provider-state' } : {}) },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Observed next action.' }] }
  ] }) }
}
test('Responses counts replayed input rather than display reasoning plus historical output usage', () => {
  const messages = [{ role: 'user', content: 'Keep requirements.' }, assistant(248257, 64200),
    { role: 'user', content: 'Observed result.' }, assistant(151821, 39712), { role: 'user', content: 'Continue.' }]
  const before = structuredClone(messages)
  const meter = requestContextBudget({ configState, model: route.model, messages })
  assert.ok(meter.tokens < 1000, JSON.stringify(meter))
  assert.ok(meter.requiredTokens < meter.limit)
  assert.equal(meter.estimated, true)
  assert.deepEqual(messages, before, 'private history and native continuity must remain untouched')
  for (const type of ['openai-compatible', 'gateway']) {
    const alias = structuredClone(configState)
    Object.assign(alias.config.provider.fixture, { type, protocol: 'responses' })
    assert.ok(requestContextBudget({ configState: alias, model: route.model, messages }).tokens < 1000)
  }
})

test('unsupported historic media reaches the normal capability guard, not an estimator exception', () => {
  assert.doesNotThrow(() => requestContextBudget({ configState, model: route.model,
    messages: [{ role: 'user', content: [{ type: 'audio', data: 'AA==' }] }] }))
})
test('opaque native reasoning remains budgeted once and stale channel state is not replayed', () => {
  const messages = [assistant(248257, 64200, true)]
  const meter = requestContextBudget({ configState, model: route.model, messages })
  assert.ok(meter.tokens >= 64200 && meter.tokens < 65200)
  const switched = requestContextBudget({ configState, model: route.model, messages, baseUrl: 'http://127.0.0.1:1235/v1' })
  assert.ok(switched.tokens < 1000, 'stale native state is excluded by the same scope check as dispatch')
  const kimi = structuredClone(configState); kimi.config.provider.fixture.type = 'openai-compatible'
  assert.ok(requestContextBudget({ configState: kimi, model: route.model, messages }).tokens > 60000,
    'a channel that replays reasoning_content must not silently discard it')
})
