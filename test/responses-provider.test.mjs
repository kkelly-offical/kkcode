import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { responsesEndpoint, responsesPayload, responsesInput, parseResponsesResult, requestResponses, requestResponsesStream } from '../src/kernel/provider/responses.mjs'
import { attachResponsesState, stripProviderState } from '../src/kernel/provider/responses-state.mjs'
import { createProviderRegistry } from '../src/kernel/provider/router.mjs'
import { resolveProviderConnection } from '../src/kernel/provider/model-catalog.mjs'
import { validateConfig } from '../src/config/schema.mjs'
import { sessionView } from '../src/device/session-view.mjs'
import { requestContextBudget } from '../src/kernel/session/context-budget.mjs'
import { createKernel } from '../src/kernel/index.mjs'

const tool = { name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }
const input = (overrides = {}) => ({ baseUrl: 'https://fixture.invalid/v1', model: 'responses-fixture', apiKey: 'fixture-key', provider: 'fixture', system: { blocks: [{ text: 'stable instruction', cacheable: true }, { text: 'dynamic instruction' }] }, messages: [{ role: 'user', content: 'hello' }], tools: [tool], maxTokens: 512, timeoutMs: 3000, retry: { retries: 0 }, ...overrides })
const message = (text, id = 'msg_1') => ({ type: 'message', id, role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] })
const reasoning = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Checking the file.' }], encrypted_content: 'fixture-opaque-reasoning' }
const call = (id = 'call_1', args = '{"file_path":"hello.txt"}') => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name: 'read', arguments: args, status: 'completed' })
const response = (output = [message('done')], extra = {}) => ({ id: 'resp_fixture', status: 'completed', output, usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 5 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 6 } }, ...extra })
const sse = events => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
async function withFetch(t, fetch) { const previous = globalThis.fetch; globalThis.fetch = fetch; t.after(() => { globalThis.fetch = previous }) }
async function collect(iterable) { const rows = []; for await (const row of iterable) rows.push(row); return rows }

test('Responses request shape uses stateless input, flattened functions and output budget, not Chat fields', () => {
  const body = responsesPayload(input({ reasoningEffort: 'high', reasoningSummary: 'auto' }), true)
  assert.equal(body.store, false); assert.equal(body.stream, true); assert.equal(body.max_output_tokens, 512)
  assert.equal(body.instructions, 'stable instruction\n\ndynamic instruction')
  assert.equal(body.tools[0].name, 'read'); assert.equal(body.tools[0].strict, false)
  assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' })
  assert.deepEqual(body.include, ['reasoning.encrypted_content'])
  for(const key of ['messages', 'max_tokens', 'stream_options', 'previous_response_id']) assert.equal(key in body, false)
  assert.equal(JSON.stringify(body).includes('cache_control'), false)
  assert.equal(responsesEndpoint('https://fixture.invalid/v1/'), 'https://fixture.invalid/v1/responses')
  assert.equal(responsesEndpoint('https://fixture.invalid/v1/responses'), 'https://fixture.invalid/v1/responses')
  assert.throws(() => responsesEndpoint('https://user:pass@fixture.invalid/'), /账号密码/)
})

test('Responses message conversion preserves tool outputs and their image siblings', () => {
  const images = [{ type: 'image', mediaType: 'image/png', data: 'fixture-data' }]
  const result = responsesInput(input({ messages: [
    { role: 'assistant', content: [{ type: 'text', text: 'Checking' }, { type: 'tool_use', id: 'c1', name: 'read', input: { file_path: 'image.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'Image file' }, ...images] }
  ] }))
  assert.deepEqual(result.map(item => item.type || item.role), ['assistant', 'function_call', 'function_call_output', 'user'])
  assert.equal(result[2].call_id, 'c1'); assert.equal(result[2].output, 'Image file')
  assert.equal(result[3].content[0].type, 'input_image'); assert.equal(result[3].content[0].image_url, 'data:image/png;base64,fixture-data')
  assert.throws(() => responsesInput(input({ messages: [{ role: 'user', content: [{ type: 'audio', data: 'fixture' }] }] })), /不支持 audio/)
})

test('Responses continuity keeps encrypted reasoning and assistant phase only for the same immutable content/channel', () => {
  const native = [reasoning, { ...message('Checking'), phase: 'commentary' }, call()]
  const result = parseResponsesResult(response(native), input())
  const content = attachResponsesState([{ type: 'reasoning', text: result.reasoning }, { type: 'text', text: result.text }, { type: 'tool_use', id: 'call_1', name: 'read', input: { file_path: 'hello.txt' } }], result.providerState)
  assert.deepEqual(responsesInput(input({ messages: [{ role: 'assistant', content }] })), native)
  for(const overrides of [{ model: 'different' }, { baseUrl: 'https://other.invalid/v1' }, { apiKey: 'different-key' }]) assert.equal(JSON.stringify(responsesInput(input({ ...overrides, messages: [{ role: 'assistant', content }] }))).includes('fixture-opaque'), false)
  const edited = structuredClone(content); edited.find(block => block.type === 'text').text = 'redacted'
  assert.equal(JSON.stringify(responsesInput(input({ messages: [{ role: 'assistant', content: edited }] }))).includes('fixture-opaque'), false)
  assert.equal(attachResponsesState([{ type: 'text', text: 'changed by a hook' }], result.providerState).some(block => block.type === 'provider_state'), false)
  const changedCall = structuredClone(content).filter(block => block.type !== 'provider_state')
  changedCall.find(block => block.type === 'tool_use').input.file_path = 'changed.txt'
  assert.equal(attachResponsesState(changedCall, result.providerState).some(block => block.type === 'provider_state'), false)
  assert.equal(JSON.stringify(stripProviderState([{ role: 'assistant', content }])).includes('fixture-opaque'), false)
  const projected = sessionView({ session: { id: 's' }, messages: [{ id: 'm', role: 'assistant', content }], parts: [] })
  assert.equal(JSON.stringify(projected).includes('fixture-opaque'), false)
  const estimate = requestContextBudget({ model: 'fixture', messages: [{ role: 'assistant', content }] })
  assert.ok(estimate.components.messages >= 6)
})

test('Responses parses usage, safe source citations, refusal and deterministic tool argument errors', () => {
  const item = message('Answer')
  item.content[0].annotations = [{ type: 'url_citation', title: 'Source', url: 'https://example.org/source' }, { type: 'url_citation', title: 'Bad', url: 'javascript:alert(1)' }]
  const result = parseResponsesResult(response([reasoning, item, call('bad', '{broken')]), input())
  assert.deepEqual(result.usage, { input: 15, output: 10, cacheRead: 5, cacheWrite: 0 })
  assert.equal(result.reasoning, 'Checking the file.'); assert.ok(result.text.includes('[Source](<https://example.org/source>)')); assert.ok(!result.text.includes('javascript'))
  assert.equal(result.toolCalls[0].args.__parse_error, true)
  assert.throws(() => parseResponsesResult(response([call(), call()]), input()), /重复/)
  assert.throws(() => parseResponsesResult(response([call()], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), input()), /未完整/)
  assert.throws(() => parseResponsesResult(response([{ ...call(), status: 'in_progress' }]), input()), /未完整/)
  assert.throws(() => parseResponsesResult(response([message('partial')], { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }), input()), /被服务端过滤/)
  assert.equal(parseResponsesResult(response([message('partial')], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), input()).stopReason, 'max_tokens')
  assert.equal(parseResponsesResult(response([{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Cannot help with this.' }] }]), input()).text, 'Cannot help with this.')
  const malformed = parseResponsesResult(response([message('text')], { usage: { input_tokens: -1, output_tokens: Infinity, output_tokens_details: { reasoning_tokens: 'not a number' } } }), input())
  assert.deepEqual(malformed.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); assert.equal(malformed.providerState.reasoningTokens, 0)
})

test('Responses non-streaming uses KK Code identity and exact custom endpoint', async t => {
  let request
  await withFetch(t, async (url, init) => { request = { url, init }; return Response.json(response()) })
  const result = await requestResponses(input({ baseUrl: 'https://fixture.invalid/custom/responses' }))
  assert.equal(result.text, 'done'); assert.equal(request.url, 'https://fixture.invalid/custom/responses')
  assert.match(new Headers(request.init.headers).get('User-Agent'), /^KK[ -]Code/)
  assert.equal(request.init.redirect, 'error'); assert.equal(JSON.parse(request.init.body).store, false)
})

test('Responses stream buffers interleaved tools until a real completion, merges reasoning/text and final usage', async t => {
  const a = call('a', '{"file_path":"a"}'), b = call('b', '{"file_path":"b"}')
  await withFetch(t, async () => sse([
    { type: 'response.created', response: { id: 'r' } },
    { type: 'response.reasoning_summary_text.delta', delta: 'Checking ' },
    { type: 'response.reasoning_summary_text.delta', delta: 'files.' },
    { type: 'response.output_text.delta', delta: 'Reading' },
    { type: 'response.output_item.added', output_index: 2, item: { ...a, arguments: '' } },
    { type: 'response.output_item.added', output_index: 3, item: { ...b, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 3, delta: '{"file_path":' },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: a.arguments },
    { type: 'response.function_call_arguments.delta', output_index: 3, delta: '"b"}' },
    { type: 'response.completed', response: response([reasoning, message('Reading'), a, b]) }
  ]))
  const chunks = await collect(requestResponsesStream(input()))
  assert.equal(chunks.filter(row => row.type === 'thinking').map(row => row.content).join(''), 'Checking files.')
  assert.equal(chunks.filter(row => row.type === 'text').map(row => row.content).join(''), 'Reading')
  assert.deepEqual(chunks.filter(row => row.type === 'tool_call').map(row => row.call.id), ['a', 'b'])
  assert.equal(chunks.at(-1).reason, 'tool_use')
  assert.equal(chunks.find(row => row.type === 'provider_state').state.items[0].encrypted_content, 'fixture-opaque-reasoning')
})

test('Responses retries before output, never replays partial text and never emits unfinished tools', async t => {
  let count = 0
  await withFetch(t, async () => { count++; return sse([{ type: 'response.output_item.added', output_index: 0, item: call() }]) })
  await assert.rejects(collect(requestResponsesStream(input({ retry: { retries: 5, baseDelayMs: 1 } }))), /完成标记前中断/)
  assert.equal(count, 6)
  count = 0; globalThis.fetch = async () => { count++; return sse([{ type: 'response.output_text.delta', delta: 'partial' }, { type: 'response.output_item.added', output_index: 0, item: call() }]) }
  const chunks = []
  await assert.rejects(async () => { for await (const chunk of requestResponsesStream(input({ retry: { retries: 5, baseDelayMs: 1 } }))) chunks.push(chunk) }, /完成标记前中断/)
  assert.equal(count, 1); assert.deepEqual(chunks.map(row => row.type), ['text'])
})

test('Responses JSON fallback, in-stream failure, 401 and cancellation retain failure semantics', async t => {
  await withFetch(t, async () => Response.json(response([message('fallback')])))
  assert.equal((await collect(requestResponsesStream(input()))).filter(row => row.type === 'text')[0].content, 'fallback')
  globalThis.fetch = async () => sse([{ type: 'response.failed', response: { status: 'failed', error: { code: 'invalid_prompt', message: 'bad input' } } }])
  await assert.rejects(collect(requestResponsesStream(input())), /bad input/)
  globalThis.fetch = async () => sse([{ type: 'response.output_text.delta', delta: 'partial' }, { type: 'response.completed', response: response([message('')]) }])
  await assert.rejects(collect(requestResponsesStream(input())), /最终结果不一致/)
  let count = 0
  globalThis.fetch = async () => { count++; return Response.json({ error: { message: 'bad key' } }, { status: 401 }) }
  await assert.rejects(requestResponses(input({ retry: { retries: 5, baseDelayMs: 1 } })), /401/); assert.equal(count, 1)
  globalThis.fetch = async () => Response.json({ error: { message: 'x'.repeat(690) + 'fixture-key' + ' secret=fixture-password' } }, { status: 400 })
  await assert.rejects(requestResponses(input()), error => !error.message.includes('fixture-ke') && !error.message.includes('fixture-password'))
  const controller = new AbortController(); controller.abort()
  globalThis.fetch = async (_url, options) => { options.signal.throwIfAborted(); throw new Error('not reached') }
  await assert.rejects(collect(requestResponsesStream(input({ signal: controller.signal }))))
})

test('Responses body/idle timeouts fail instead of hanging after headers', async t => {
  await withFetch(t, async () => new Response(new ReadableStream({ start() {}, cancel() {} }), { headers: { 'content-type': 'application/json' } }))
  await assert.rejects(requestResponses(input({ timeoutMs: 30 })), /timed out/)
  globalThis.fetch = async () => new Response(new ReadableStream({ start() {}, cancel() {} }), { headers: { 'content-type': 'text/event-stream' } })
  await assert.rejects(collect(requestResponsesStream(input({ streamIdleTimeoutMs: 30 }))), /timeout/)
  globalThis.fetch = async () => new Response('data: ' + 'x'.repeat(16 * 1024 * 1024), { headers: { 'content-type': 'text/event-stream' } })
  await assert.rejects(collect(requestResponsesStream(input())), /16 MiB/)
})

test('Responses routing/config/catalog work with named providers, builtin channel names and gateway protocol', async t => {
  const requests = []
  await withFetch(t, async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return Response.json(response()) })
  const registry = createProviderRegistry()
  for(const [name, entry] of [['company', { type: 'openai-responses' }], ['openai', { type: 'openai-responses', protocol: 'anthropic' }], ['company', { type: 'gateway', protocol: 'responses', endpoints: { responses: 'https://fixture.invalid/v1/responses' } }], ['company', { type: 'openai-compatible', protocol: 'responses' }]]) {
    const config = { provider: { default: name, strict_mode: true, [name]: { base_url: 'https://fixture.invalid/v1', api_key: 'fixture-key', default_model: 'responses-fixture', ...entry } } }
    assert.equal(validateConfig(config).valid, true)
    assert.equal(resolveProviderConnection({ config }, name).modelsUrl, 'https://fixture.invalid/v1/models')
    const result = await registry.requestProvider({ configState: { config }, providerType: name, system: '', messages: [{ role: 'user', content: 'test' }], tools: [], audit: false })
    assert.equal(result.text, 'done'); assert.ok(requests.at(-1).url.endsWith('/responses')); assert.ok(Array.isArray(requests.at(-1).body.input))
  }
})

test('real HTTP Responses kernel round executes a governed read and replays private native continuity on the next call', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-responses-round-')), cwd = path.join(root, 'workspace')
  await mkdir(cwd); await writeFile(path.join(cwd, 'fixture.txt'), 'RESPONSES_TOOL_READ_OK')
  const old = process.env.KKCODE_HOME; process.env.KKCODE_HOME = path.join(root, 'state'); await mkdir(process.env.KKCODE_HOME)
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body)
    const completed = body.input.some(item => item.type === 'function_call_output')
    const output = completed ? [message('Responses workflow completed.')] : [reasoning, { ...message('Checking the workspace'), phase: 'commentary' }, call('read-fixture', JSON.stringify({ path: path.join(cwd, 'fixture.txt') }))]
    const result = response(output)
    res.setHeader('content-type', 'text/event-stream'); res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: result })}\n\n`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await writeFile(path.join(process.env.KKCODE_HOME, 'config.json'), JSON.stringify({ provider: { default: 'fixture', fixture: { type: 'openai-responses', api_key_env: '', base_url: `http://127.0.0.1:${server.address().port}/v1`, default_model: 'responses-fixture', retry_attempts: 0 } }, mcp: { auto_discover: false }, skills: { auto_seed: false }, session: { recovery: false, title_generation: false }, permission: { level: 'readonly' } }))
  const kernel = await createKernel({ cwd, boot: false, trustState: { trusted: true } })
  t.after(async () => { try { await kernel.shutdown() } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if(old === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = old; await rm(root, { recursive: true, force: true }) } })
  assert.equal(kernel.configState.config.provider.default, 'fixture', JSON.stringify(kernel.configState.validation || {}))
  const result = await kernel.executeTurn({ prompt: 'Read fixture.txt and report its marker.', mode: 'plan' })
  assert.ok(result.reply.includes('Responses workflow completed.'), result.reply)
  assert.match(result.sessionId, /^[A-Za-z0-9_-]+$/)
  const second = requests.find(body => body.input.some(item => item.type === 'function_call_output'))
  assert.ok(second.input.some(item => item.type === 'function_call_output' && item.output.includes('RESPONSES_TOOL_READ_OK')), JSON.stringify(second.input.filter(item => item.type === 'function_call_output')))
  assert.ok(second.input.some(item => item.type === 'reasoning' && item.encrypted_content === 'fixture-opaque-reasoning'))
  assert.ok(second.input.some(item => item.type === 'message' && item.phase === 'commentary'))
  assert.ok(requests.every(body => body.store === false && !('previous_response_id' in body)))
  const follow = await kernel.executeTurn({ sessionId: result.sessionId, prompt: 'Summarize the already-read marker.' })
  assert.equal(follow.sessionId, result.sessionId); assert.equal(follow.mode, 'plan'); assert.ok(follow.reply.includes('Responses workflow completed.'))
})
