import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createStdioMcpClient } from '../src/kernel/mcp/client-stdio.mjs'
import { createSdkMcpClient } from '../src/kernel/mcp/client-sdk.mjs'
import { startOfficialHttpFixture } from './fixtures/official-mcp-server.mjs'

const fixture = fileURLToPath(new URL('./fixtures/official-mcp-server.mjs', import.meta.url))
const stdio = paged => createStdioMcpClient('sdk-fixture', { command: [process.execPath, fixture, ...(paged ? ['paged'] : [])], shell: false, framing: 'newline', timeout_ms: 5000 })

async function exercise(client) {
  assert.equal((await client.health()).ok, true)
  const tools = await client.listTools(), echo = tools.find(tool => tool.name === 'echo')
  assert.deepEqual(echo.inputSchema.required, ['text'])
  assert.equal(echo.inputSchema.additionalProperties, false)
  const result = await client.callTool('echo', { text: '你好', label: null })
  assert.equal(result.output, '你好')
  assert.deepEqual(result.structuredContent, { text: '你好', repeat: 1 })
  assert.equal((await client.callTool('echo', { text: '✓', repeat: 2 })).output, '✓✓')
  await assert.rejects(client.callTool('echo', { text: 'x', repeat: '2' }), /validation|invalid|expected|校验/i)
  await assert.rejects(client.callTool('echo', {}), /validation|invalid|expected|校验/i)
  await assert.rejects(client.callTool('echo', { text: 'x', unexpected: true }), /validation|invalid|unrecognized|校验/i)
  await assert.rejects(client.callTool('failure', {}), /fixture controlled error/)
  assert.ok((await client.listPrompts()).some(prompt => prompt.name === 'review'))
  assert.equal((await client.getPrompt('review', { file: 'src/main.mjs' })).messages[0].content.text, 'Review src/main.mjs')
  assert.ok((await client.listResources()).some(resource => resource.uri === 'fixture://guide'))
  assert.match((await client.readResource('fixture://guide')).contents[0].text, /参数可选/)
  assert.ok((await client.listTemplates()).some(resource => resource.uriTemplate === 'fixture://files/{name}'))
  await assert.rejects(client.callTool('wait', {}, AbortSignal.timeout(30)))
  assert.equal((await client.callTool('echo', { text: 'after cancel' })).output, 'after cancel')
}

test('official SDK stdio interoperates with Unicode, optional fields, schemas, prompts, resources and cancellation', { timeout: 15000 }, async t => {
  const client = stdio(false); t.after(() => client.shutdown())
  await exercise(client)
})

for (const mode of [{ name: '2026 negotiated HTTP', modern: true }, { name: 'legacy stateful Streamable HTTP SSE', modern: false }, { name: 'legacy stateful Streamable HTTP JSON', modern: false, json: true }]) {
  test(`official SDK ${mode.name} interoperates across the full catalog and invocation path`, { timeout: 15000 }, async t => {
    const server = await startOfficialHttpFixture(mode), client = createSdkMcpClient('sdk-fixture', { transport: 'streamable-http', url: server.url, timeout_ms: 5000 })
    t.after(async () => { await client.shutdown(); await server.close() })
    await exercise(client)
    assert.ok(server.requests.every(request => request.userAgent?.startsWith('KK-Code/') && request.client === 'cli'))
    assert.ok(server.requests.some(request => request.rpc === (mode.modern ? 'server/discover' : 'initialize')))
    assert.ok(server.requests.some(request => request.version === (mode.modern ? '2026-07-28' : '2025-11-25')))
    if (!mode.modern) assert.ok(server.requests.some(request => request.session), 'subsequent requests retain negotiated HTTP session')
  })
}

test('official SDK stdio catalog pagination includes later tools, prompts, resources and templates', { timeout: 15000 }, async t => {
  const client = stdio(true); t.after(() => client.shutdown())
  assert.equal((await client.listTools()).length, 2)
  assert.equal((await client.listPrompts()).length, 2)
  assert.equal((await client.listResources()).length, 2)
  assert.equal((await client.listTemplates()).length, 2)
  assert.equal((await client.callTool('echo_2', { text: 'second page' })).output, 'second page')
})

test('default stdio framing uses the MCP newline transport without a failed startup probe', { timeout: 10000 }, async t => {
  const client = createStdioMcpClient('sdk-default', { command: [process.execPath, fixture], shell: false, timeout_ms: 1000 })
  t.after(() => client.shutdown())
  const health = await client.health()
  assert.equal(health.ok, true)
  assert.equal(health.framing, 'newline')
})

test('stdio paginated optional capabilities reject repeated cursors instead of silently returning partial catalogs', { timeout: 10000 }, async t => {
  const client = createStdioMcpClient('sdk-repeated', { command: [process.execPath, fixture, 'repeated'], shell: false, framing: 'newline', timeout_ms: 1000 })
  t.after(() => client.shutdown())
  await assert.rejects(client.listTools(), /repeated MCP catalog cursor/)
  await assert.rejects(client.listPrompts(), /repeated MCP catalog cursor/)
})

test('SDK MCP transport rejects credentials over non-loopback cleartext before making a request', async () => {
  const client = createSdkMcpClient('unsafe', { transport: 'streamable-http', url: 'http://mcp.invalid/mcp', headers: { Authorization: 'Bearer fixture-value' } })
  try { assert.equal((await client.health()).ok, false); await assert.rejects(client.listTools(), /require HTTPS/) } finally { await client.shutdown() }
})
