import test from 'node:test'
import assert from 'node:assert/strict'
import { requestOpenAI, requestOpenAIStream } from '../src/kernel/provider/openai.mjs'
import { requestAnthropicStream } from '../src/kernel/provider/anthropic.mjs'

test('malformed tool JSON never copies argument contents into logs or parse-error metadata', async t => {
  const marker = 'PRIVATE_ARGUMENT_FIXTURE', raw = `{broken:${marker}}`, errors = []
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')))
  const input = { apiKey: 'fixture', baseUrl: 'https://fixture.example.test/v1', model: 'fixture', messages: [{ role: 'user', content: 'test' }], retry: { retries: 0 } }
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'one', function: { name: 'read', arguments: raw } }] }, finish_reason: 'tool_calls' }] }), { headers: { 'content-type': 'application/json' } }))
  const result = await requestOpenAI(input)
  assert.equal(result.toolCalls[0].args.__parse_error, true)
  assert.ok(!JSON.stringify(result).includes(marker))
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'two', function: { name: 'read', arguments: raw } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  const chunks = []; for await (const chunk of requestOpenAIStream(input)) chunks.push(chunk)
  assert.ok(!JSON.stringify(chunks).includes(marker))
  const frames = [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'three', name: 'read', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: raw } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_stop' }
  ]
  globalThis.fetch = async () => new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  const anthropic = []; for await (const chunk of requestAnthropicStream(input)) anthropic.push(chunk)
  assert.ok(!JSON.stringify(anthropic).includes(marker))
  assert.equal(errors.length, 3)
  assert.ok(errors.every(error => error.includes('contents omitted') && !error.includes(marker)))
})
