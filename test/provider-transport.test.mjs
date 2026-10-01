import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {Agent, getGlobalDispatcher, setGlobalDispatcher} from 'undici'
import {providerFetch} from '../src/http/provider-transport.mjs'
import {requestResponses} from '../src/kernel/provider/responses.mjs'
import {requestOpenAI} from '../src/kernel/provider/openai.mjs'
import {requestAnthropic} from '../src/kernel/provider/anthropic.mjs'
import {requestOllama} from '../src/kernel/provider/ollama.mjs'

async function server(t, handler) {
  const instance = createServer(handler)
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve))
  t.after(async () => {instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve))})
  return `http://127.0.0.1:${instance.address().port}`
}

test('provider dispatcher escapes hidden parser timeouts without changing the global dispatcher', async t => {
  const old = getGlobalDispatcher(), short = new Agent({headersTimeout: 30, bodyTimeout: 30, pipelining: 0})
  setGlobalDispatcher(short)
  t.after(async () => {setGlobalDispatcher(old); await short.destroy()})
  // Undici's parser uses coarse fast timers: wait beyond two ticks instead of
  // mistaking a 150ms server for a real timeout regression.
  const url = await server(t, (_req, res) => setTimeout(() => {if (!res.destroyed) res.end('delayed response')}, 2200))
  await assert.rejects(fetch(url, {signal: AbortSignal.timeout(5000)}), error => error.cause?.code === 'UND_ERR_HEADERS_TIMEOUT')
  assert.equal(await (await providerFetch(url, {redirect: 'error', signal: AbortSignal.timeout(5000)})).text(), 'delayed response')
  assert.equal(getGlobalDispatcher(), short, 'provider-specific policy does not alter browser, gateway or other consumers')
})

test('caller cancellation/deadline still aborts pending provider headers, without replay', async t => {
  let requests = 0, disconnected = false
  const url = await server(t, (req, res) => {requests++; res.on('close', () => {disconnected = true})})
  await assert.rejects(providerFetch(url, {method: 'POST', redirect: 'error', body: '{}', signal: AbortSignal.timeout(50)}))
  for (let i = 0; !disconnected && i < 20; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(disconnected, true); assert.equal(requests, 1)
  assert.throws(() => providerFetch(url, {redirect: 'error'}), /cancellation signal/)
  assert.throws(() => providerFetch(url, {redirect: 'follow', signal: AbortSignal.timeout(50)}), /redirect/)
  for (const endpoint of ['file:///private', 'data:text/plain,test', 'http://user:password@127.0.0.1/']) assert.throws(() => providerFetch(endpoint, {redirect: 'error', signal: AbortSignal.timeout(50)}), /HTTP\(S\)/)
})

test('redirect policy rejects forwarding credentials to a different origin', async t => {
  let reached = 0
  const target = await server(t, (_req, res) => {reached++; res.end('not authorized')})
  const start = await server(t, (_req, res) => {res.writeHead(307, {location: target}); res.end()})
  await assert.rejects(providerFetch(start, {redirect: 'error', headers: {Authorization: 'Bearer fixture-credential'}, signal: AbortSignal.timeout(1000)}))
  assert.equal(reached, 0)
})

test('protocol-owned body idle deadlines are not replaced by the hidden parser timeout', async t => {
  const old = getGlobalDispatcher(), short = new Agent({bodyTimeout: 30, pipelining: 0})
  setGlobalDispatcher(short); t.after(async () => {setGlobalDispatcher(old); await short.destroy()})
  const url = await server(t, (_req, res) => {res.write('first'); setTimeout(() => {if (!res.destroyed) res.end('last')}, 2200)})
  const response = await providerFetch(url, {redirect: 'error', signal: AbortSignal.timeout(5000)})
  assert.equal(await response.text(), 'firstlast')
})

test('caller cancellation also stops an already-connected response body without replay', async t => {
  let requests = 0
  const url = await server(t, (_req, res) => {requests++; res.write('partial')})
  const controller = new AbortController()
  const response = await providerFetch(url, {redirect: 'error', signal: controller.signal})
  const text = response.text(); controller.abort()
  await assert.rejects(text, error => error.name === 'AbortError')
  assert.equal(requests, 1)
})

const fixtures = [
  ['Responses', requestResponses, {id: 'r', status: 'completed', output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'ready'}]}], usage: {input_tokens: 1, output_tokens: 1}}],
  ['OpenAI', requestOpenAI, {choices: [{message: {content: 'ready'}, finish_reason: 'stop'}], usage: {prompt_tokens: 1, completion_tokens: 1}}],
  ['Anthropic', requestAnthropic, {content: [{type: 'text', text: 'ready'}], stop_reason: 'end_turn', usage: {input_tokens: 1, output_tokens: 1}}],
  ['Ollama', requestOllama, {message: {content: 'ready'}, done: true, prompt_eval_count: 1, eval_count: 1}]
]
for (const [name, request, payload] of fixtures) test(`${name} retains delayed JSON headers within its configured deadline`, async t => {
  const old = getGlobalDispatcher(), short = new Agent({headersTimeout: 30, bodyTimeout: 30, pipelining: 0})
  setGlobalDispatcher(short); t.after(async () => {setGlobalDispatcher(old); await short.destroy()})
  const endpoint = await server(t, (_req, res) => setTimeout(() => {if (!res.destroyed) {res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload))}}, 2200))
  const result = await request({baseUrl: endpoint, apiKey: 'fixture-key', model: 'fixture', system: '', messages: [], timeoutMs: 5000, retry: {retries: 0}})
  assert.equal(result.text, 'ready')
})

test('real Responses request survives the native 300-second header boundary', {skip: process.env.KKCODE_TEST_PROVIDER_LONG_HEADERS !== '1'}, async t => {
  let requests = 0
  const endpoint = await server(t, (_req, res) => {requests++; setTimeout(() => {if (!res.destroyed) {res.setHeader('content-type', 'application/json');res.end(JSON.stringify(fixtures[0][2]))}}, 302000)})
  const result = await requestResponses({baseUrl: endpoint, apiKey: 'fixture-key', model: 'fixture', messages: [], timeoutMs: 340000, retry: {retries: 0}})
  assert.equal(result.text, 'ready'); assert.equal(requests, 1)
})
