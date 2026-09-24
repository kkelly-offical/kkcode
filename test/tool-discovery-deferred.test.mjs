import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createToolRegistry } from '../src/kernel/tool/registry.mjs'
import { searchToolMetadata } from '../src/kernel/tool/discovery.mjs'
import { createTaskTool, taskModelSchema, normalizeTaskBrief } from '../src/kernel/tool/task-tool.mjs'
import { validateToolArguments } from '../src/kernel/tool/validate-args.mjs'

function fixtureRegistry(count = 30) {
  let called = 0
  const config = { tool: { sources: { builtin: true, local: false, plugin: false, mcp: true } }, mcp: { auto_discover: false } }
  const mcp = { initialize: async () => {}, listTools: () => Array.from({ length: count }, (_, n) => ({ id: `mcp_fixture_${n}`, server: 'fixture', description: n === 4 ? 'Search PostgreSQL database tables 查询数据库' : `generic utility ${n}`, inputSchema: { type: 'object', properties: {} } })), callTool: async () => { called++; return { output: 'executed' } } }
  return { registry: createToolRegistry({ mcpRegistry: mcp }), config, called: () => called }
}

test('large MCP inventories defer schemas while full SDK inventory and legacy aliases remain intact', async () => {
  const { registry, config } = fixtureRegistry()
  await registry.initialize({ config })
  const full = await registry.list({ config }), model = await registry.listForModel({ config })
  assert.equal(full.filter(tool => tool.name.startsWith('mcp_fixture_')).length, 30)
  assert.ok(model.some(tool => tool.name === 'tool_search'))
  assert.equal(model.filter(tool => tool.name.startsWith('mcp_')).length, 0)
  assert.ok(!model.some(tool => tool.name === 'browser'))
  assert.ok((await registry.listForModel({ config, activated: new Set(['browser']) })).some(tool => tool.name === 'browser'))
  assert.ok(model.some(tool => tool.name === 'read'))
  for (const name of ['patch', 'multiedit', 'task_get', 'background_output', 'background_cancel']) {
    assert.ok(await registry.get(name))
    assert.ok(!model.some(tool => tool.name === name))
  }
  assert.ok((await registry.listForModel({ config: { ...config, tool: { ...config.tool, legacy_aliases: true, discovery: { enabled: false } } } })).some(tool => tool.name === 'patch'))
})

test('search returns bounded schemas, activates this turn only and never executes or widens allowlists', async () => {
  const { registry, config, called } = fixtureRegistry(), activated = new Set()
  await registry.initialize({ config })
  const search = await registry.get('tool_search')
  const result = await search.execute({ query: 'PostgreSQL database', limit: 2 }, { config, activateTools: names => names.forEach(name => activated.add(name)) })
  assert.equal(result.tools[0].name, 'mcp_fixture_4')
  assert.ok(result.tools[0].inputSchema)
  assert.equal(called(), 0)
  assert.ok((await registry.listForModel({ config, activated })).some(tool => tool.name === 'mcp_fixture_4'))
  assert.ok(!(await registry.listForModel({ config, activated: new Set() })).some(tool => tool.name === 'mcp_fixture_4'))
  assert.deepEqual((await search.execute({ query: 'PostgreSQL' }, { config, allowedToolNames: ['tool_search', 'mcp_fixture_1'] })).tools, [])
  assert.equal((await registry.listForModel({ config, allowedTools: ['mcp_fixture_4'] })).length, 1, 'agents without discovery get their explicit tools eagerly')
})

test('BM25 supports CJK metadata and exact identifiers, with deterministic empty/tied results', () => {
  const tools = [{ name: 'mcp_database', description: '查询数据库的数据', inputSchema: {} }, { name: 'mcp_mail', description: 'send email', inputSchema: {} }]
  assert.equal(searchToolMetadata(tools, '数据库')[0].name, 'mcp_database')
  assert.equal(searchToolMetadata(tools, 'mcp_mail')[0].name, 'mcp_mail')
  assert.deepEqual(searchToolMetadata(tools, 'unknown'), [])
  assert.deepEqual(searchToolMetadata(tools, ''), [])
  const related = [{ name: 'browser', description: 'Open an isolated page with controlled navigation and many supported operations.', inputSchema: {} }, { name: 'browser_bridge', description: 'Browser browser browser', inputSchema: {} }]
  assert.equal(searchToolMetadata(related, 'browser', 1)[0].name, 'browser', 'an exact tool name must not lose to a shorter or repeated-word description')
  assert.equal(searchToolMetadata(related, ' BROWSER ', 1)[0].name, 'browser')
})

test('background MCP refresh preserves the host resource and prompt catalog tools', async () => {
  const { registry, config } = fixtureRegistry(2)
  await registry.initialize({ config })
  const resource = await registry.get('mcp_resource'), prompt = await registry.get('mcp_prompt')
  registry.refreshMcpTools(); registry.refreshMcpTools()
  assert.equal(await registry.get('mcp_resource'), resource)
  assert.equal(await registry.get('mcp_prompt'), prompt)
  assert.equal((await registry.list({ config })).filter(tool => ['mcp_resource', 'mcp_prompt'].includes(tool.name)).length, 2)
})

test('builtin detailed instructions are available on demand without invoking the tool', async () => {
  const { registry, config } = fixtureRegistry(0)
  await registry.initialize({ config })
  const result = await (await registry.get('tool_search')).execute({ query: 'task', limit: 1 }, { config, allowedToolNames: ['task', 'tool_search'] })
  assert.equal(result.tools[0].name, 'task')
  assert.match(result.tools[0].instructions, /structured brief fields/)
  assert.match(result.tools[0].instructions, /Execution contract/)
})

test('task advertises a compact brief and still accepts all legacy flat arguments', async () => {
  const task = createTaskTool(), surface = taskModelSchema(task.inputSchema)
  assert.equal(Object.keys(surface.properties).length, 8)
  assert.ok(surface.properties.brief.properties.budget_usd)
  assert.ok(task.inputSchema.properties.budget_usd)
  assert.deepEqual(normalizeTaskBrief({ prompt: 'x', brief: { objective: 'goal', write_scope: 'read-only' }, objective: 'explicit' }), { prompt: 'x', objective: 'explicit', write_scope: 'read-only' })
  assert.throws(() => normalizeTaskBrief({ brief: { subagent_type: 'hidden-routing' } }), /unknown fields/)
  let received
  await task.execute({ prompt: 'x', brief: { budget_usd: 0.5 } }, { delegateTask: async args => { received = args; return { ok: true } } })
  assert.equal(received.budget_usd, 0.5)
})

test('canonical edit accepts line ranges and atomic batches without bypassing read-before-edit', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-canonical-edit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, 'a.txt'), 'one\ntwo\nthree\n')
  const { registry, config } = fixtureRegistry(0); await registry.initialize({ config, cwd: root })
  const edit = await registry.get('edit'), read = await registry.get('read')
  const range = { path: 'a.txt', start_line: 2, end_line: 2, content: 'changed' }
  await assert.doesNotReject(validateToolArguments(edit, range))
  assert.equal((await edit.execute(range, { cwd: root })).metadata.blocked, true)
  await read.execute({ path: 'a.txt' }, { cwd: root })
  await edit.execute(range, { cwd: root })
  assert.match(await readFile(path.join(root, 'a.txt'), 'utf8'), /changed/)
  const batch = { changes: [{ path: 'a.txt', before: 'changed', after: 'final' }] }
  await edit.execute(batch, { cwd: root })
  assert.match(await readFile(path.join(root, 'a.txt'), 'utf8'), /final/)
  await assert.rejects(validateToolArguments(edit, { ...range, changes: [] }), /Invalid arguments/, 'ambiguous edit forms are rejected')
})
