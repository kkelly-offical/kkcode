import test from 'node:test'
import assert from 'node:assert/strict'
import { configuredProviders, defaultProviderName, effectiveSelection, mergeModelIds, modelLabel, capabilityLabel } from '../apps/web/src/models.mjs'

const settings = {
  provider: {
    default: 'kimi',
    model_context: 128000,
    model_thinking: null,
    model_capabilities: { 'kimi-for-coding': { image: true } },
    kimi: { type: 'openai', base_url: 'https://api.example.com/v1', default_model: 'kimi-for-coding' },
    local: { type: 'openai', default_model: '' },
    broken: 'not-an-object',
  },
}

test('configuredProviders lists real connections only, skipping reserved keys and scalars', () => {
  assert.deepEqual(configuredProviders(settings), [
    { name: 'kimi', defaultModel: 'kimi-for-coding' },
    { name: 'local', defaultModel: '' },
  ])
  assert.deepEqual(configuredProviders({}), [])
  assert.deepEqual(configuredProviders(null), [])
})

test('defaultProviderName honors the configured default and falls back to the first provider', () => {
  assert.equal(defaultProviderName(settings), 'kimi')
  assert.equal(defaultProviderName({ provider: { default: 'missing', local: { default_model: 'x' } } }), 'local')
  assert.equal(defaultProviderName({}), '')
})

test('effectiveSelection keeps the session choice when configured and fills model from provider defaults', () => {
  assert.deepEqual(effectiveSelection(settings, { provider: 'local', model: 'qwen3' }), { provider: 'local', model: 'qwen3' })
  assert.deepEqual(effectiveSelection(settings, { provider: 'kimi', model: '' }), { provider: 'kimi', model: 'kimi-for-coding' })
  assert.deepEqual(effectiveSelection(settings, { provider: 'unknown', model: 'ghost' }), { provider: 'kimi', model: 'ghost' })
  assert.deepEqual(effectiveSelection({}, {}), { provider: '', model: '' })
})

test('mergeModelIds dedupes in order with the configured default first', () => {
  assert.deepEqual(mergeModelIds(['a'], ['b', 'a', ''], ['c', 'b']), ['a', 'b', 'c'])
  assert.deepEqual(mergeModelIds(undefined, null), [])
})

test('modelLabel strips vendor prefixes so the composer chip stays compact', () => {
  assert.equal(modelLabel('anthropic/claude-sonnet-4'), 'claude-sonnet-4')
  assert.equal(modelLabel('kimi-for-coding'), 'kimi-for-coding')
  assert.equal(modelLabel(''), '')
})

test('capability badges explicitly mark heuristics and omit unknown values', () => {
  assert.equal(capabilityLabel(), '')
  assert.equal(capabilityLabel({ capabilities: { image: true, audio: false, tools: true }, capabilitySources: { image: 'heuristic', tools: 'discovered' } }), '图像? · 工具')
})
