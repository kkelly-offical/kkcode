import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validateToolArguments } from '../src/kernel/tool/validate-args.mjs'
import { executeTool } from '../src/kernel/tool/executor.mjs'
import { createMcpRegistry } from '../src/kernel/mcp/registry.mjs'
import { createToolRegistry } from '../src/kernel/tool/registry.mjs'
import { startOfficialHttpFixture } from './fixtures/official-mcp-server.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-tool-schema-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state'); await mkdir(process.env.KKCODE_HOME)
  t.after(async () => { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  return root
}

test('tool validation preserves optional/null inputs without coercion, default insertion or extra-field removal', async t => {
  const root = await fixture(t), calls = []
  const tool = { name: 'fixture_typed', inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, count: { type: 'integer', minimum: 1, default: 2 }, note: { type: ['string', 'null'] }, options: { type: 'object', properties: { format: { enum: ['text', 'json'] } }, required: ['format'], additionalProperties: false } }, required: ['path'], additionalProperties: false }, execute: async args => { calls.push(structuredClone(args)); return { output: 'executed' } } }
  const run = args => executeTool({ tool, args, sessionId: 'schema-fixture', turnId: 'turn', context: { cwd: root, config: {} } })
  const supplied = { path: 'a', note: null }
  assert.equal((await run(supplied)).status, 'completed')
  assert.deepEqual(supplied, { path: 'a', note: null })
  assert.deepEqual(calls, [{ path: 'a', note: null }])
  for (const args of [{}, { path: '' }, { path: 'a', count: '2' }, { path: 'a', count: 0 }, { path: 'a', unknown: true }, { path: 'a', options: { format: 'xml' } }]) assert.equal((await run(args)).status, 'error')
  assert.equal(calls.length, 1, 'invalid arguments never reach tool implementation')
})

test('JSON Schema draft-2020-12, draft-2019-09 and draft-07 retain their own validation semantics', () => {
  const modern = { name: 'modern', inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { enabled: { type: 'boolean' }, token: { type: 'string' }, tuple: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }], items: false } }, dependentRequired: { enabled: ['token'] }, unevaluatedProperties: false } }
  assert.doesNotThrow(() => validateToolArguments(modern, { tuple: ['a', 1] }))
  assert.throws(() => validateToolArguments(modern, { enabled: true }), /Invalid arguments/)
  assert.throws(() => validateToolArguments(modern, { extra: true }), /Invalid arguments/)
  assert.throws(() => validateToolArguments(modern, { tuple: ['a', '1'] }), /Invalid arguments/)
  const intermediate = { name: '2019', inputSchema: { $schema: 'https://json-schema.org/draft/2019-09/schema', type: 'object', properties: { enabled: { type: 'boolean' }, token: { type: 'string' } }, dependentRequired: { enabled: ['token'] }, unevaluatedProperties: false } }
  assert.doesNotThrow(() => validateToolArguments(intermediate, { enabled: true, token: 'fixture-value' }))
  assert.throws(() => validateToolArguments(intermediate, { enabled: true }), /Invalid arguments/)
  const { $schema: _dialect, ...withoutDialect } = modern.inputSchema
  assert.throws(() => validateToolArguments({ name: 'mcp_fixture_modern', inputSchema: withoutDialect }, { enabled: true }), /Invalid arguments/, 'MCP defaults to 2020-12 even without an explicit schema URI')
  const legacy = { name: 'legacy', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { enabled: { type: 'boolean' }, token: { type: 'string' } }, dependencies: { enabled: ['token'] } } }
  assert.doesNotThrow(() => validateToolArguments(legacy, { enabled: true, token: 'fixture-value' }))
  assert.throws(() => validateToolArguments(legacy, { enabled: true }), /Invalid arguments/)
})

test('official MCP server flows through KK Code registry and governed executor without widening tool arguments', { timeout: 15000 }, async t => {
  const root = await fixture(t), server = await startOfficialHttpFixture(), mcp = createMcpRegistry()
  t.after(async () => { await mcp.shutdown(); await server.close() })
  const tools = createToolRegistry({ mcpRegistry: mcp })
  await tools.initialize({ cwd: root, allowProjectSources: false, config: { compat: { plugins: { ecosystems: ['kkcode'] } }, mcp: { auto_discover: false, servers: { fixture: { transport: 'streamable-http', url: server.url, timeout_ms: 5000 } } }, tool: { sources: { builtin: false, local: false, plugin: false, mcp: true } } } })
  const tool = await tools.get('mcp_fixture_echo')
  assert.ok(tool)
  const execute = args => executeTool({ tool, args, sessionId: 'mcp-fixture', turnId: 'turn', context: { cwd: root, config: {} } })
  const result = await execute({ text: 'governed tool call', label: null })
  assert.equal(result.status, 'completed')
  assert.equal(result.output, 'governed tool call')
  assert.deepEqual(result.metadata.mcp.structuredContent, { text: 'governed tool call', repeat: 1 })
  const requests = server.requests.filter(request => request.rpc === 'tools/call').length
  assert.equal((await execute({ text: 'must not reach server', repeat: '2' })).status, 'error')
  assert.equal(server.requests.filter(request => request.rpc === 'tools/call').length, requests)
  assert.match((await mcp.readResource('fixture', 'fixture://guide')).contents[0].text, /参数可选/)
})
