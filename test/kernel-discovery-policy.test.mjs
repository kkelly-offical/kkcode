import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createKernel } from '../src/kernel/index.mjs'
import { currentRuntime } from '../src/kernel/core/runtime-context.mjs'
import { createToolRegistry } from '../src/kernel/tool/registry.mjs'
import { createTaskDelegate } from '../src/kernel/orchestration/task-scheduler.mjs'

async function kernelFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-discovery-turn-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  await mkdir(path.join(root, '.git'))
  const kernel = await createKernel({ cwd: root, boot: false, trustState: { trusted: true } })
  const config = kernel.configState.config
  config.provider = { default: 'fixture', fixture: { default_model: 'fixture', stream: false, retry_attempts: 0 } }
  config.permission = { level: 'yolo', rules: [] }
  config.agent.max_steps = 4; config.agent.verify_completion = false
  config.skills.auto_seed = false; config.mcp.auto_discover = false
  config.tool.sources = { builtin: true, local: false, plugin: false, mcp: false }
  t.after(async () => {
    await kernel.shutdown()
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  })
  return { kernel, root, config }
}

const reply = (text, toolCalls = []) => ({ text, toolCalls, stopReason: toolCalls.length ? 'tool_use' : 'end_turn', usage: { input: 1, output: 1 } })

test('a real turn discovers MCP schemas for the next request, executes only after discovery, and resets on the next turn', async t => {
  const { kernel, config } = await kernelFixture(t)
  let executions = 0, calls = 0
  const seen = []
  const mcp = { initialize: async () => {}, listTools: () => Array.from({ length: 30 }, (_, n) => ({ id: `mcp_fixture_${n}`, server: 'fixture', description: n === 4 ? 'lookup database users' : `utility ${n}`, inputSchema: { type: 'object', properties: {} } })), callTool: async () => { executions++; return { output: 'database result' } } }
  config.tool.sources.mcp = true
  const tools = createToolRegistry({ mcpRegistry: mcp })
  await tools.initialize({ config, cwd: kernel.cwd })
  await kernel.run(() => { currentRuntime().tools = tools })
  kernel.providers.registerProvider('fixture', { async request(input) {
    seen.push(input.tools.map(tool => tool.name)); calls++
    if (calls === 1) return reply('', [{ id: 'search', name: 'tool_search', args: { query: 'database users', limit: 1 } }])
    if (calls === 2) return reply('', [{ id: 'lookup', name: 'mcp_fixture_4', args: {} }])
    return reply('done')
  }, async *requestStream() { throw new Error('stream disabled in fixture') } })
  const result = await kernel.executeTurn({ prompt: 'look up a user', sessionId: 'discover-turn', model: 'fixture', providerType: 'fixture' })
  assert.equal(result.reply, 'done')
  assert.equal(seen[0].some(name => name.startsWith('mcp_')), false)
  assert.equal(seen[1].includes('mcp_fixture_4'), true)
  assert.equal(executions, 1)
  await kernel.executeTurn({ prompt: 'another turn', sessionId: 'discover-turn', model: 'fixture', providerType: 'fixture' })
  assert.equal(seen.at(-1).some(name => name.startsWith('mcp_')), false)
})

test('model-invoked skill restricts later calls even if the provider guesses hidden tool names', async t => {
  const { kernel, root } = await kernelFixture(t)
  const dir = path.join(root, '.kkcode', 'skills', 'restricted')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), '---\nname: restricted\ndescription: inspect only\nallowed-tools: Read\n---\nInspect files without changing them.')
  const seen = []; let calls = 0
  kernel.providers.registerProvider('fixture', { async request(input) {
    seen.push(input.tools.map(tool => tool.name)); calls++
    if (calls === 1) return reply('', [{ id: 'skill1', name: 'skill', args: { skill: 'restricted' } }])
    if (calls === 2) return reply('', [{ id: 'write1', name: 'write', args: { path: 'forbidden.txt', content: 'no' } }])
    return reply('stopped')
  }, async *requestStream() { throw new Error('stream disabled in fixture') } })
  const result = await kernel.executeTurn({ prompt: 'inspect', sessionId: 'skill-restriction', model: 'fixture', providerType: 'fixture' })
  assert.equal(result.reply, 'stopped')
  assert.deepEqual(seen[1], ['read'])
  assert.ok(result.toolEvents.some(event => /active skill allowed-tools/.test(event.output || '')))
})

test('skill policy is included in delegated run specifications for background workers', async () => {
  let runSpec
  const delegate = createTaskDelegate({ config: {}, parentSessionId: 'policy-parent', model: 'fixture', providerType: 'fixture', getSkillToolGroups: () => [['read', 'grep']], runSubtask: async payload => { runSpec = payload.runSpec; return { reply: 'done', toolEvents: [] } } })
  await delegate({ prompt: 'inspect', subagent_type: 'explore' })
  assert.deepEqual(runSpec.toolContext.skillToolGroups, [['read', 'grep']])
})
