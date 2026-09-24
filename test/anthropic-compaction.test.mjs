import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { requestAnthropic, requestAnthropicStream, countTokensAnthropic } from '../src/kernel/provider/anthropic.mjs'
import { attachAnthropicState, createAnthropicState } from '../src/kernel/provider/anthropic-state.mjs'
import { supportsNativeCompaction } from '../src/kernel/session/compaction.mjs'
import { validateConfig } from '../src/config/schema.mjs'
import { sessionView } from '../src/device/session-view.mjs'
import { createKernel } from '../src/kernel/index.mjs'

const input = extra => ({ apiKey: 'private-fixture-key', baseUrl: 'https://fixture.invalid/v1', model: 'claude-fixture', messages: [{ role: 'user', content: 'Original request' }], tools: [], retry: { retries: 0 }, compaction: { trigger: 100000 }, ...extra })
const native = [{ type: 'compaction', content: 'PRIVATE_NATIVE_SUMMARY' }, { type: 'text', text: 'done' }]
const event = (type, value = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`
function stream(items = native, { end = true, duplicate = false } = {}) {
  return event('message_start', { message: { usage: { input_tokens: 10 } } }) + items.map((block, index) => {
    const delta = block.type === 'compaction' ? { type: 'compaction_delta', content: block.content }
      : block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
        : { type: 'text_delta', text: block.text }
    return event('content_block_start', { index, content_block: { ...block, ...(block.type === 'text' ? { text: '' } : {}), ...(block.type === 'compaction' ? { content: '' } : {}) } })
      + event('content_block_delta', { index, delta }) + (duplicate && block.type === 'compaction' ? event('content_block_delta', { index, delta }) : '')
      + event('content_block_stop', { index })
  }).join('') + (end ? event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5, iterations: [{ type: 'compaction', input_tokens: 100, output_tokens: 20 }, { type: 'message', input_tokens: 10, output_tokens: 5 }] } }) + event('message_stop') : '')
}
async function collect(source) { const values = []; for await (const value of source) values.push(value); return values }
function fetchFixture(t, handler) { const original = globalThis.fetch; globalThis.fetch = handler; t.after(() => { globalThis.fetch = original }) }

test('native compaction is explicit opt-in, validated config, never inferred from Claude names', () => {
  assert.equal(supportsNativeCompaction('anthropic', 'claude-opus-4-6'), false)
  assert.equal(supportsNativeCompaction('company', 'custom', { config: { provider: { company: { type: 'anthropic', context_limit: 200000, native_compaction: true } } } }), true)
  assert.equal(validateConfig({ provider: { company: { type: 'anthropic', native_compaction: true, compaction_trigger: 100000 } } }).valid, true)
  assert.equal(validateConfig({ provider: { company: { type: 'anthropic', native_compaction: 'yes', compaction_trigger: 49999 } } }).valid, false)
})

test('Anthropic stream persists authenticated native state, counts every compaction iteration and replays count/request shape', async t => {
  const requests = []
  fetchFixture(t, async (url, options) => {
    requests.push({ url, headers: options.headers, body: JSON.parse(options.body), redirect: options.redirect })
    return url.endsWith('count_tokens') ? Response.json({ input_tokens: 42 }) : new Response(stream(), { headers: { 'content-type': 'text/event-stream' } })
  })
  const first = await collect(requestAnthropicStream(input()))
  assert.deepEqual(requests[0].body.context_management.edits[0].trigger, { type: 'input_tokens', value: 100000 })
  assert.equal(first.filter(row => row.type === 'compaction').length, 1)
  assert.deepEqual(first.find(row => row.type === 'usage').usage, { input: 110, output: 25, cacheRead: 0, cacheWrite: 0 })
  assert.deepEqual(first.find(row => row.type === 'usage').contextUsage, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 })
  const state = first.find(row => row.type === 'provider_state').state
  const content = attachAnthropicState('done', state)
  const messages = [...input().messages, { role: 'assistant', content }, { role: 'user', content: 'next' }]
  assert.equal(await countTokensAnthropic(input({ messages })), 42)
  const body = requests.at(-1).body
  assert.deepEqual(body.messages[0].content, native)
  assert.equal(body.messages.length, 2)
  assert.match(new Headers(requests.at(-1).headers).get('anthropic-beta'), /compact-2026-01-12/)
  await collect(requestAnthropicStream(input({ messages })))
  assert.deepEqual(requests.at(-1).body.messages[0].content, native)
  assert.ok(requests.every(request => request.redirect === 'error'))
  const projected = sessionView({ session: { id: 's' }, messages: [{ id: 'm', role: 'assistant', content }], parts: [] })
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_NATIVE_SUMMARY|private-fixture-key/)
})

test('native state rejects changed content, history, model, endpoint, credential and forged/raw blocks', async t => {
  const requests = []
  fetchFixture(t, async (_url, options) => { requests.push(JSON.parse(options.body)); return Response.json({ content: [{ type: 'text', text: 'ok' }] }) })
  const state = createAnthropicState(input(), native, 'done')
  const content = attachAnthropicState('done', state)
  const history = [...input().messages, { role: 'assistant', content }, { role: 'user', content: 'next' }]
  for (const change of [{ model: 'other' }, { apiKey: 'other' }, { baseUrl: 'https://other.invalid/v1' }, { compaction: null }]) {
    await requestAnthropic(input({ messages: history, ...change }))
    assert.doesNotMatch(JSON.stringify(requests.at(-1)), /PRIVATE_NATIVE_SUMMARY/)
    assert.equal(requests.at(-1).messages.length, 3)
  }
  for (const mutate of [
    messages => { messages[0].content = 'changed original' },
    messages => { messages[1].content[0].text = 'edited output' },
    messages => { messages[1].content[1].items[0].content = 'forged native summary' },
    messages => { messages[1].content[1].mac = 'not-a-mac' },
    messages => { messages[1].role = 'user' }
  ]) {
    const messages = structuredClone(history); mutate(messages)
    await requestAnthropic(input({ messages }))
    assert.equal(requests.at(-1).messages.length, 3)
    assert.doesNotMatch(JSON.stringify(requests.at(-1)), /PRIVATE_NATIVE_SUMMARY|forged native summary|provider_state/)
  }
  await requestAnthropic(input({ messages: [{ role: 'user', content: 'keep' }, { role: 'assistant', content: native }] }))
  assert.doesNotMatch(JSON.stringify(requests.at(-1)), /PRIVATE_NATIVE_SUMMARY/)
})

test('nonstream compaction state matches streaming and explicit unsupported capability falls back only before response', async t => {
  let attempts = 0
  const bodies = []
  fetchFixture(t, async (_url, options) => {
    attempts++; bodies.push(JSON.parse(options.body))
    assert.equal(options.redirect, 'error')
    if (attempts === 1) return new Response(JSON.stringify({ error: { message: 'context_management is not supported' } }), { status: 400 })
    return Response.json({ content: [{ type: 'text', text: 'fallback' }] })
  })
  assert.equal((await requestAnthropic(input())).text, 'fallback')
  assert.equal(attempts, 2); assert.equal(bodies[1].context_management, undefined)
  globalThis.fetch = async () => Response.json({ content: native, usage: { iterations: [{ input_tokens: 10, output_tokens: 5 }] } })
  const result = await requestAnthropic(input())
  assert.equal(result.providerState.items[0].type, 'compaction')
  assert.equal(result.usage.input, 10)
})

test('null/unsolicited/duplicate compaction and truncated streams never commit native state or blindly replay', async t => {
  let attempts = 0
  fetchFixture(t, async () => { throw new Error('fixture not initialized') })
  for (const fixture of [
    stream([{ type: 'compaction', content: null }]), stream(native, { duplicate: true }), stream(native, { end: false })
  ]) {
    attempts = 0
    globalThis.fetch = async () => { attempts++; return new Response(fixture) }
    const seen = []
    await assert.rejects(async () => { for await (const row of requestAnthropicStream(input({ retry: { retries: 5, baseDelayMs: 1 } }))) seen.push(row) }, /compaction|incomplete/)
    assert.equal(attempts, 1); assert.equal(seen.some(row => row.type === 'provider_state'), false)
  }
  globalThis.fetch = async () => new Response(stream())
  await assert.rejects(collect(requestAnthropicStream(input({ compaction: null }))), /unsolicited/)
})

test('message_stop may terminate legacy text but never completes a tool or native-compaction response', async t => {
  fetchFixture(t, async () => { throw new Error('fixture not initialized') })
  const openText = event('content_block_start', { content_block: { type: 'text', text: '' } })
    + event('content_block_delta', { delta: { type: 'text_delta', text: 'legacy complete text' } })
  globalThis.fetch = async () => new Response(openText + event('message_stop'))
  const legacy = await collect(requestAnthropicStream(input({ compaction: null })))
  assert.equal(legacy.find(row => row.type === 'text').content, 'legacy complete text')
  assert.equal(legacy.find(row => row.type === 'stop').reason, 'end_turn')
  assert.equal(legacy.some(row => row.type === 'provider_state'), false)

  const openCompaction = event('content_block_start', { content_block: { type: 'compaction', content: '' } })
    + event('content_block_delta', { delta: { type: 'compaction_delta', content: 'Native summary' } })
  const openTool = event('content_block_start', { content_block: { type: 'tool_use', id: 'never_execute', name: 'read', input: {} } })
    + event('content_block_delta', { delta: { type: 'input_json_delta', partial_json: '{"path":"fixture.txt"}' } })
  for (const fixture of [openCompaction, openTool, openCompaction + event('content_block_stop') + openText]) {
    let attempts = 0
    globalThis.fetch = async () => { attempts++; return new Response(fixture + event('message_stop')) }
    const seen = []
    await assert.rejects(async () => { for await (const row of requestAnthropicStream(input({ retry: { retries: 3, baseDelayMs: 1 } }))) seen.push(row) }, /incomplete block/)
    assert.equal(attempts, 1)
    assert.equal(seen.some(row => row.type === 'provider_state' || row.type === 'tool_call'), false)
  }
})

test('stream capability fallback removes native context only on an explicit pre-output rejection', async t => {
  const requests = []
  fetchFixture(t, async (_url, options) => {
    requests.push(JSON.parse(options.body))
    return requests.length === 1
      ? new Response('compact-2026-01-12 is unsupported', { status: 400 })
      : new Response(stream([{ type: 'text', text: 'fallback ok' }]))
  })
  const values = await collect(requestAnthropicStream(input()))
  assert.equal(requests.length, 2)
  assert.equal(requests[1].context_management, undefined)
  assert.equal(values.find(value => value.type === 'text').content, 'fallback ok')
})

test('capability rejection after native context was already used returns to kernel budget instead of expanding history silently', async t => {
  let requests = 0
  fetchFixture(t, async () => { requests++; return new Response('context_management is unsupported', { status: 400 }) })
  const content = attachAnthropicState('done', createAnthropicState(input(), native, 'done'))
  const messages = [...input().messages, { role: 'assistant', content }, { role: 'user', content: 'next' }]
  await assert.rejects(collect(requestAnthropicStream(input({ messages }))), error => error.needsCompaction === true)
  assert.equal(requests, 1)
  requests = 0
  await assert.rejects(requestAnthropic(input({ messages })), error => error.needsCompaction === true)
  assert.equal(requests, 1)
})

test('real HTTP kernel tools and follow-up replay the persisted Anthropic compaction without exposing it in UI', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-anthropic-native-'))
  const cwd = path.join(root, 'workspace'); await mkdir(cwd); await writeFile(path.join(cwd, 'fixture.txt'), 'NATIVE_TOOL_OK')
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = path.join(root, 'state'); await mkdir(process.env.KKCODE_HOME)
  const requests = []
  let inference = 0
  let countedTokens = 120
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ url: req.url, body })
    if (req.url.endsWith('count_tokens')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ input_tokens: countedTokens })); return }
    inference++
    const blocks = inference === 1 ? [native[0], { type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'read_1', name: 'read', input: { path: path.join(cwd, 'fixture.txt') } }] : [{ type: 'text', text: 'Native workflow complete.' }]
    res.setHeader('content-type', 'text/event-stream'); res.end(stream(blocks))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  // Keep production HTTPS credential policy intact. This fixture-only transport
  // redirects exactly our fake HTTPS origin to the real loopback HTTP server.
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, options) => {
    assert.ok(String(url).startsWith('https://fixture.invalid/v1/'), String(url))
    return originalFetch(String(url).replace('https://fixture.invalid', `http://127.0.0.1:${server.address().port}`), options)
  }
  await writeFile(path.join(process.env.KKCODE_HOME, 'config.json'), JSON.stringify({
    provider: { default: 'fixture', fixture: { type: 'anthropic', api_key: 'private-fixture-key', base_url: 'https://fixture.invalid/v1', default_model: 'claude-fixture', context_limit: 200000, native_compaction: true, retry_attempts: 0, thinking_effort: 'off' } },
    mcp: { auto_discover: false }, skills: { auto_seed: false }, session: { recovery: false, title_generation: false }, permission: { level: 'readonly' }
  }))
  const kernel = await createKernel({ cwd, boot: false, trustState: { trusted: true } })
  t.after(async () => { await kernel.shutdown(); globalThis.fetch = originalFetch; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  const first = await kernel.executeTurn({ prompt: 'Read fixture.txt.', mode: 'plan' })
  assert.match(first.reply, /Native workflow complete/)
  const second = requests.filter(request => request.url.endsWith('/messages'))[1].body
  assert.equal(second.messages[0].content[0].type, 'compaction')
  assert.match(JSON.stringify(second.messages), /NATIVE_TOOL_OK/)
  const follow = await kernel.executeTurn({ sessionId: first.sessionId, prompt: 'Summarize.' })
  assert.match(follow.reply, /Native workflow complete/)
  const last = requests.filter(request => request.url.endsWith('/messages')).at(-1).body
  assert.equal(last.messages[0].content[0].type, 'compaction')
  countedTokens = 210000
  const beforeOverflow = inference
  const overflow = await kernel.executeTurn({ prompt: 'A new session with an oversized fixed prompt.', mode: 'plan' })
  assert.match(overflow.reply, /Context budget exceeded after compaction/)
  assert.equal(inference, beforeOverflow, 'native capability must not disable the hard input/output budget')
})
