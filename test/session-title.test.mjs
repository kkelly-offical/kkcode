import test from 'node:test'
import assert from 'node:assert/strict'
import { refineSessionTitle, normalizeTitle } from '../src/kernel/session/session-title.mjs'

const configState = { config: { provider: { default: 'local', local: { default_model: 'conversation-model' } }, models: { fast: 'must-not-use-fast' } } }
function fixture(initial = {}) {
  let value = { title: 'First question', titleSource: 'auto', titleRevision: 0, ...initial }
  const calls = [], events = []
  return {
    get value() { return value },
    rename(title) { value = { ...value, title, titleSource: 'manual', titleRevision: value.titleRevision + 1 } },
    calls, events,
    deps: {
      getSession: async () => ({ session: structuredClone(value), messages: [] }),
      updateSessionIf: async (_id, expected, patch) => {
        if (Object.entries(expected).some(([key, entry]) => value[key] !== entry)) return null
        value = { ...value, ...patch }; return structuredClone(value)
      },
      requestProvider: async input => { calls.push(input); return { text: '登录页设计' } },
      emit: async event => events.push(event)
    }
  }
}
const run = (f, options = {}) => refineSessionTitle({ configState, sessionId: 'session', prompt: 'First question', ...options, deps: f.deps })

test('titles are single-line, unquoted, control-safe and capped', () => {
  assert.equal(normalizeTitle('「中文标题」'), '中文标题')
  assert.equal(normalizeTitle('Title: Login page'), 'Login page')
  assert.equal(normalizeTitle('**Login page**'), 'Login page')
  assert.equal(normalizeTitle('first line\nsecond'), 'first line')
  assert.equal(normalizeTitle('x'.repeat(80)).length, 50)
  assert.ok(!normalizeTitle('safe\u001b[31mred\u001b[0m').includes('\u001b'))
})
test('title uses the first conversation provider/model without requiring or using a fast model', async () => {
  const f = fixture()
  assert.equal(await run(f, { model: 'selected-at-first-question', baseUrl: 'https://fixture.invalid/v1', apiKeyEnv: 'FIXTURE_PROVIDER_KEY' }), '登录页设计')
  assert.equal(f.calls[0].providerType, 'local')
  assert.equal(f.calls[0].model, 'selected-at-first-question')
  assert.equal(f.calls[0].baseUrl, 'https://fixture.invalid/v1')
  assert.equal(f.calls[0].apiKeyEnv, 'FIXTURE_PROVIDER_KEY')
  assert.deepEqual(f.calls[0].tools, [])
  assert.equal(f.calls[0].maxTokens, 512)
  assert.equal(f.value.titleSource, 'generated')
  assert.equal(f.events[0].type, 'session.title.updated')
  assert.equal(await run(f), null); assert.equal(f.calls.length, 1)
})
test('a manual title prevents generation before any request', async () => {
  const f = fixture({ title: 'My own title', titleSource: 'manual' })
  assert.equal(await run(f), null); assert.equal(f.calls.length, 0)
})
test('manual rename wins when it races an already running model request', async () => {
  const f = fixture()
  f.deps.requestProvider = async () => { f.rename('用户命名'); return { text: 'Late generated title' } }
  assert.equal(await run(f), null); assert.equal(f.value.title, '用户命名')
  assert.equal(f.events.length, 0)
})
test('concurrent first-turn completion only issues one title request', async () => {
  const f = fixture()
  await Promise.all([run(f), run(f)])
  assert.equal(f.calls.length, 1)
})
test('empty answers and request failures keep the original title and do not repeat paid requests', async () => {
  for (const answer of ['', null]) {
    const f = fixture()
    f.deps.requestProvider = async () => { if (answer === null) throw new Error('offline'); return { text: answer } }
    assert.equal(await run(f), null); assert.equal(f.value.title, 'First question')
    assert.equal(await run(f), null)
  }
})
test('title usage is reported even when a concurrent manual rename wins', async () => {
  const f = fixture(), counted = []
  f.deps.requestProvider = async () => { f.rename('Manual'); return { text: 'Generated', usage: { input: 5, output: 2 } } }
  assert.equal(await run(f, { onUsage: async usage => counted.push(usage) }), null)
  assert.deepEqual(counted, [{ input: 5, output: 2 }])
})
