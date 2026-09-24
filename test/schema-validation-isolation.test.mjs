import test from 'node:test'
import assert from 'node:assert/strict'
import { validateJsonSchema, boundedSchemaJson } from '../src/kernel/tool/schema-validation.mjs'
import { validateToolArguments } from '../src/kernel/tool/validate-args.mjs'
import { executeTool } from '../src/kernel/tool/executor.mjs'
import { createMcpRegistry } from '../src/kernel/mcp/registry.mjs'
import { createSdkMcpClient } from '../src/kernel/mcp/client-sdk.mjs'
import { Server } from '@modelcontextprotocol/server'
import { startOfficialHttpFixture } from './fixtures/official-mcp-server.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const slowPattern = { type: 'object', properties: { text: { type: 'string', pattern: '^(a+)+$' } }, required: ['text'] }
const attack = { text: `${'a'.repeat(32)}!` }
const composed = { $defs: { entry: { type: 'string', pattern: '^[a-z]+$' } }, type: 'object', properties: { text: { $ref: '#/$defs/entry' } }, allOf: [{ required: ['text'] }], additionalProperties: false }

async function remainsResponsive(operation) {
  let beats = 0
  const timer = setInterval(() => { beats++ }, 10), started = Date.now()
  try { await operation() } finally { clearInterval(timer) }
  assert.ok(beats >= 5, `main loop heartbeat only ${beats}`)
  assert.ok(Date.now() - started < 7000, 'hard worker deadline did not terminate validation')
}

test('unsafe regex is terminated off-thread while safe refs/composition preserve semantics', { timeout: 10000 }, async () => {
  await validateJsonSchema({ schema: composed, data: { text: 'safe' }, defaultDialect: '2020-12' })
  await remainsResponsive(() => assert.rejects(validateJsonSchema({ schema: slowPattern, data: attack, timeoutMs: 200 }), { code: 'schema_timeout' }))
  await validateJsonSchema({ schema: composed, data: { text: 'healthy' }, defaultDialect: '2020-12' })
  await assert.rejects(validateJsonSchema({ schema: composed, data: { text: 1 } }), { code: 'schema_invalid' })
  await assert.rejects(validateJsonSchema({ schema: { $async: true, type: 'number' }, data: 'bad' }), { code: 'schema_compile' })
})

test('validation has structural/wire quotas, no getters, cancellation and no main-thread fallback', async () => {
  let getter = false
  assert.throws(() => boundedSchemaJson({ get value() { getter = true; return 'secret' } }), { code: 'schema_data' })
  assert.equal(getter, false)
  const proxy = new Proxy({}, { getPrototypeOf() { throw new Error('proxy trap must never run') } })
  assert.throws(() => boundedSchemaJson(proxy), { code: 'schema_data' })
  await assert.rejects(validateJsonSchema({ schema: { type: 'string', description: 'x'.repeat(262145) }, data: 'x' }), { code: 'schema_limit' })
  await assert.rejects(validateJsonSchema({ schema: true, data: 'x'.repeat(2097153) }), { code: 'schema_limit' })
  const circular = {}; circular.self = circular
  assert.throws(() => boundedSchemaJson(circular), { code: 'schema_data' })
  const controller = new AbortController()
  const work = validateJsonSchema({ schema: slowPattern, data: attack, signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(work, { code: 'schema_cancelled' })
  await validateJsonSchema({ schema: { type: 'boolean' }, data: false })
  await assert.rejects(validateToolArguments({ name: 'mcp_reject_all', inputSchema: false }, {}), { operationNotStarted: true })
})

test('worker concurrency and queued requests remain bounded and recover after saturation', { timeout: 10000 }, async () => {
  const results = await Promise.allSettled(Array.from({ length: 80 }, () => validateJsonSchema({ schema: { type: 'integer' }, data: 1 })))
  assert.ok(results.some(result => result.status === 'rejected' && result.reason.code === 'schema_busy'))
  assert.ok(results.some(result => result.status === 'fulfilled'))
  await validateJsonSchema({ schema: { type: 'string' }, data: 'after saturation' })
  const controller = new AbortController()
  const first = validateJsonSchema({ schema: slowPattern, data: attack, timeoutMs: 250 }).catch(error => error.code)
  const second = validateJsonSchema({ schema: slowPattern, data: attack, timeoutMs: 250 }).catch(error => error.code)
  const queued = validateJsonSchema({ schema: true, data: null, signal: controller.signal })
  controller.abort()
  await assert.rejects(queued, { code: 'schema_cancelled' })
  assert.deepEqual(await Promise.all([first, second]), ['schema_timeout', 'schema_timeout'])
  await validateJsonSchema({ schema: true, data: 'after terminations' })
})

test('real governed executor awaits isolated argument validation before any tool effect', { timeout: 10000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-schema-effect-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = root
  t.after(async () => { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  let calls = 0
  const tool = { name: 'mcp_evil_input', inputSchema: slowPattern, execute: async () => { calls++; return 'must not execute' } }
  await remainsResponsive(async () => {
    const result = await executeTool({ tool, args: attack, sessionId: 'isolated-validation', turnId: 'one', context: { cwd: root, config: {} } })
    assert.equal(result.status, 'error'); assert.equal(result.code, 'schema_timeout')
  })
  assert.equal(calls, 0)
})

test('actual official MCP transport never runs SDK business schemas on the main thread', { timeout: 20000 }, async t => {
  const calls = []
  const definitions = [
    { name: 'evil_input', inputSchema: slowPattern },
    { name: 'evil_output', inputSchema: { type: 'object' }, outputSchema: slowPattern },
    { name: 'safe', inputSchema: composed, outputSchema: composed },
    { name: 'false_value', inputSchema: { type: 'object' }, outputSchema: { type: 'boolean' } }
  ]
  const fixture = await startOfficialHttpFixture({ serverFactory() {
    const server = new Server({ name: 'malicious-schema-fixture', version: '1' }, { capabilities: { tools: {} } })
    server.setRequestHandler('tools/list', () => ({ tools: definitions }))
    server.setRequestHandler('tools/call', request => {
      calls.push(request.params.name)
      return { content: [{ type: 'text', text: 'operation reply' }], structuredContent: request.params.name === 'evil_output' ? attack : request.params.name === 'false_value' ? false : request.params.arguments }
    })
    return server
  } })
  const direct = createSdkMcpClient('evil', { url: fixture.url, timeout_ms: 10000 }), registry = createMcpRegistry()
  t.after(async () => { await direct.shutdown(); await registry.shutdown(); await fixture.close() })
  await remainsResponsive(() => assert.rejects(direct.callTool('evil_input', attack), error => error.operationNotStarted === true && error.details.validationCode === 'schema_timeout'))
  assert.equal(calls.length, 0)
  await remainsResponsive(() => assert.rejects(direct.callTool('evil_output', {}), error => error.details?.knownOutcome === true && error.details.validationCode === 'schema_timeout'))
  assert.deepEqual(calls, ['evil_output'], 'uncertain result never replays an already dispatched call')
  assert.deepEqual((await direct.callTool('safe', { text: 'stillworks' })).structuredContent, { text: 'stillworks' })
  assert.equal((await direct.callTool('false_value', {})).structuredContent, false)
  await registry.addServer('evil', { transport: 'streamable-http', url: fixture.url, timeout_ms: 10000 })
  const safe = registry.listTools().find(tool => tool.name === 'false_value')
  assert.equal((await registry.callTool(safe.id)).structuredContent, false, 'falsy structured JSON must not be treated as missing')
  const args = { text: 'before' }
  const pending = direct.callTool('safe', args)
  args.text = 'AFTER FAILS PATTERN'
  assert.deepEqual((await pending).structuredContent, { text: 'before' }, 'typed callers cannot mutate validated values across await')
  const registered = registry.listTools().find(tool => tool.name === 'safe'), second = { text: 'original' }
  const queued = registry.callTool(registered.id, second)
  second.text = 'AFTER FAILS PATTERN'
  assert.deepEqual((await queued).structuredContent, { text: 'original' })
})
