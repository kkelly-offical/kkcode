import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createSdkMcpClient } from '../src/kernel/mcp/client-sdk.mjs'
import { createStdioMcpClient } from '../src/kernel/mcp/client-stdio.mjs'
import { createQuestionPromptChannel } from '../src/kernel/tool/question-prompt.mjs'
import { createMcpInteraction } from '../src/kernel/mcp/interaction.mjs'
import { runWithRuntime } from '../src/kernel/core/runtime-context.mjs'
import { startOfficialHttpFixture } from './fixtures/official-mcp-server.mjs'
import { createMcpCatalogTools } from '../src/kernel/tool/mcp-catalog.mjs'
import { createMcpRegistry } from '../src/kernel/mcp/registry.mjs'
import { createServer } from 'node:http'
import { normalizeToolResult } from '../src/kernel/mcp/tool-result.mjs'

function channel(value = '用户输入', action = 'accept') {
  const result = createQuestionPromptChannel(), seen = []
  result.setQuestionPromptHandler(async request => {
    seen.push(request)
    return Object.fromEntries(request.questions.map(question => [question.id, question.id === 'mcp_action' ? action : question.id === 'mcp_submit' ? 'submit' : value]))
  })
  return { result, seen }
}

for (const mode of ['modern', 'legacy', 'stdio']) test(`MCP ${mode}: official SDK multi-round form requires host user review and reports progress`, { timeout: 15000 }, async t => {
  const host = channel(), progress = []
  const server = mode === 'stdio' ? null : await startOfficialHttpFixture({ modern: mode === 'modern' })
  const client = mode === 'stdio' ? createStdioMcpClient('inputs', { command: [process.execPath, fileURLToPath(new URL('./fixtures/official-mcp-server.mjs', import.meta.url))], shell: false, timeout_ms: 5000 }, { questionPrompt: host.result })
    : createSdkMcpClient('inputs', { url: server.url, timeout_ms: 5000 }, { questionPrompt: host.result })
  t.after(async () => { await client.shutdown(); await server?.close() })
  const value = await client.callTool('collect', { label: 'A' }, null, { onprogress: event => progress.push(event.progress) })
  assert.equal(value.output, 'A:用户输入')
  assert.deepEqual(value.structuredContent, { text: '用户输入' })
  assert.equal(host.seen.length, 6, 'each input round needs consent, fields and final review')
  assert.ok(progress.length >= 1)
  const before = host.seen.length
  assert.equal((await client.callTool('collect', { sensitive: true })).output, 'decline')
  assert.equal(host.seen.length, before, 'credential fields never reach the user form')
  for (const operation of [options => client.getPrompt('slow', {}, options), options => client.readResource('fixture://slow', options)]) {
    const updates = [], controller = new AbortController()
    const pending = operation({ signal: controller.signal, onprogress: value => { updates.push(value.progress); controller.abort() } })
    await assert.rejects(pending)
    assert.ok(updates.includes(1), 'resource/prompt progress arrived before cancellation')
    assert.equal((await client.callTool('echo', { text: 'post-cancel' })).output, 'post-cancel')
  }
})

test('MCP shared connection keeps concurrent session answers separate and never guesses absent user consent', { timeout: 15000 }, async t => {
  const server = await startOfficialHttpFixture(), client = createSdkMcpClient('shared', { url: server.url, timeout_ms: 5000 })
  t.after(async () => { await client.shutdown(); await server.close() })
  const a = channel('A-answer'), b = channel('B-answer')
  const [ra, rb] = await Promise.all([
    runWithRuntime({ sessionId: 'A', questionPrompt: a.result }, () => client.callTool('collect', { label: 'A' })),
    runWithRuntime({ sessionId: 'B', questionPrompt: b.result }, () => client.callTool('collect', { label: 'B' }))
  ])
  assert.equal(ra.output, 'A:A-answer'); assert.equal(rb.output, 'B:B-answer')
  assert.ok(a.seen.every(request => request.sessionId === 'A'))
  assert.ok(b.seen.every(request => request.sessionId === 'B'))
  assert.equal((await client.callTool('collect', {})).output, 'cancel')
  const denied = channel('unused', 'decline')
  assert.equal((await runWithRuntime({ questionPrompt: denied.result }, () => client.callTool('collect', {}))).output, 'decline')
  assert.equal(denied.seen.length, 1)
})

test('MCP cancellation while waiting for a human releases server channel and rejects late answer', { timeout: 10000 }, async t => {
  const server = await startOfficialHttpFixture(), client = createSdkMcpClient('cancel', { url: server.url, timeout_ms: 5000 })
  t.after(async () => { await client.shutdown(); await server.close() })
  const questionPrompt = createQuestionPromptChannel()
  questionPrompt.setQuestionPromptHandler(() => new Promise(() => {}))
  await assert.rejects(runWithRuntime({ questionPrompt }, () => client.callTool('collect', {}, AbortSignal.timeout(150))))
  assert.equal((await client.callTool('echo', { text: 'still works' })).output, 'still works')
})

test('MCP unsupported URL and malformed form never auto-open or accept; catalog tool stays host bound', async () => {
  const host = channel(), bridge = createMcpInteraction('server', { questionPrompt: host.result })
  await bridge.run('tools/call', null, async () => {
    assert.equal((await bridge.elicit({ mode: 'url', url: 'https://example.invalid/authorize' })).action, 'decline')
    assert.equal((await bridge.elicit({ requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } } })).action, 'decline')
    for (const field of [{ type: 'string', pattern: '^(a+)+$' }, { type: 'string', $ref: '#/$defs/recursive' }, { type: 'string', allOf: [{ minLength: 1 }] }, { type: 'string', format: 'unknown-regex' }, { type: 'array', items: { type: 'string', enum: ['a'], pattern: '^(a+)+$' } }]) {
      assert.equal((await bridge.elicit({ requestedSchema: { type: 'object', properties: { text: field } } })).action, 'decline')
    }
  })
  assert.equal(host.seen.length, 0)
  const calls = [], [resources, prompts] = createMcpCatalogTools({ listServers: () => ['safe'], readResource: (...args) => { calls.push(args); return { contents: [{ text: 'untrusted' }] } }, listPrompts: () => [] })
  await assert.rejects(resources.execute({ action: 'read', server: 'unknown', uri: 'file:///etc/passwd' }, {}), /未配置/)
  const controller = new AbortController()
  assert.match((await resources.execute({ action: 'read', server: 'safe', uri: 'fixture://a' }, { signal: controller.signal })).output, /不构成系统指令/)
  assert.equal(calls[0][2].signal, controller.signal)
  assert.match((await prompts.execute({ action: 'list' }, {})).output, /\[\]/)
})

test('MCP stdio server cancellation aborts an open user form while the parent tool continues', { timeout: 10000 }, async t => {
  const questionPrompt = createQuestionPromptChannel(), requests = []
  questionPrompt.setQuestionPromptHandler(request => { requests.push(request); return new Promise(() => {}) })
  const client = createStdioMcpClient('server-cancel', { command: [process.execPath, fileURLToPath(new URL('./fixtures/official-mcp-server.mjs', import.meta.url))], shell: false, timeout_ms: 5000 }, { questionPrompt })
  t.after(() => client.shutdown())
  assert.equal((await client.callTool('cancel_form', {})).output, 'form cancelled by server')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].signal.aborted, true)
  assert.equal((await client.callTool('echo', { text: 'after server cancel' })).output, 'after server cancel')
})

test('MCP parallel input requests show one host form at a time, without automatic defaults', async () => {
  const host = channel('one'), bridge = createMcpInteraction('parallel', { questionPrompt: host.result })
  let showing = false
  host.result.setQuestionPromptHandler(async request => {
    assert.equal(showing, false, 'one visible form per bound operation')
    showing = true
    await new Promise(resolve => setTimeout(resolve, 5))
    showing = false
    return Object.fromEntries(request.questions.map(q => [q.id, q.id === 'mcp_action' ? 'accept' : q.id === 'mcp_submit' ? 'submit' : 'one']))
  })
  const request = { message: 'field', requestedSchema: { type: 'object', properties: { text: { type: 'string', default: 'must not auto-use' } }, required: ['text'] } }
  const results = await bridge.run('tools/call', null, () => Promise.all([bridge.elicit(request), bridge.elicit(request)]))
  assert.ok(results.every(result => result.action === 'accept' && result.content.text === 'one'))
})

test('MCP queued cancellation returns promptly without letting later requests overtake the active host scope', async () => {
  const bridge = createMcpInteraction('queue'), controller = new AbortController(), order = []
  let release
  const hold = new Promise(resolve => { release = resolve })
  const first = bridge.run('first', null, async () => { order.push('first'); await hold })
  const second = bridge.run('second', controller.signal, () => { throw new Error('cancelled queued operation executed') })
  const third = bridge.run('third', null, async () => { order.push('third') })
  controller.abort()
  await assert.rejects(second)
  assert.deepEqual(order, ['first'])
  release()
  await Promise.all([first, third])
  assert.deepEqual(order, ['first', 'third'])
})

test('MCP registry preserves schema/annotations, rejects invalid structured output and never retries unknown server effect', async t => {
  let calls = 0, crash = false
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/health') return response.end('{}')
    if (request.url === '/tools') return response.end(JSON.stringify({ tools: [{ name: 'typed', inputSchema: { type: 'object' }, outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] }, annotations: { readOnlyHint: true } }] }))
    if (request.url === '/tools/typed') {
      calls++
      if (crash) { response.statusCode = 500; return response.end('{}') }
      return response.end(JSON.stringify({ content: [{ type: 'text', text: 'effect completed' }], structuredContent: { count: 'wrong' } }))
    }
    response.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const registry = createMcpRegistry()
  t.after(async () => { await registry.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  await registry.addServer('typed', { transport: 'http', url: `http://127.0.0.1:${server.address().port}`, timeout_ms: 500 })
  const tool = registry.listTools()[0]
  assert.equal(tool.annotations.readOnlyHint, true)
  assert.equal(tool.outputSchema.properties.count.type, 'number')
  await assert.rejects(registry.callTool(tool.id), error => error.details?.knownOutcome === true && /结构化结果/.test(error.message))
  assert.equal(calls, 1)
  crash = true
  await assert.rejects(registry.callTool(tool.id), /HTTP 500/)
  assert.equal(calls, 2, 'a server error after send is not evidence that nothing executed')
  assert.deepEqual(normalizeToolResult({ structuredContent: { count: 1 } }, 'typed', 'typed').structuredContent, { count: 1 }, 'structured-only results must not be dropped without a text content array')
})
