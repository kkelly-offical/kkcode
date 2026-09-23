import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createKernel } from '../src/kernel/index.mjs'
import { executeTool } from '../src/kernel/tool/executor.mjs'
import { beginToolOperation, listToolOperations, resolveToolOperation } from '../src/kernel/tool/operation-journal.mjs'
import { encryptedStore } from '../src/storage/encrypted-store.mjs'

async function fixture(t, handlers = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-harness-104-')), old = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  const kernel = await createKernel({ cwd: root, boot: false, trustState: { trusted: true }, handlers })
  const config = kernel.configState.config
  Object.assign(config, { skills: { auto_seed: false }, mcp: { auto_discover: false }, git_auto: { enabled: false, auto_snapshot: false } })
  config.provider = { default: 'fixture', fixture: { default_model: 'test', stream: false, retry_attempts: 0 } }
  config.agent.max_steps = 10; config.agent.verify_completion = false; config.session.title_generation = false
  config.tool.sources = { builtin: true, local: false, plugin: false, mcp: false }
  config.permission = { level: 'accept-edits', rules: [] }
  t.after(async () => { await kernel.shutdown(); if (old === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = old; await rm(root, { recursive: true, force: true }) })
  return { root, kernel, config }
}
test('declarative composition enforces child approvals and stops after denial without undoing prior work', async t => {
  let approvals = 0
  const { root, kernel } = await fixture(t, { onPermissionPrompt: async () => { approvals++; return 'deny' } })
  let turn = 0
  kernel.providers.registerProvider('fixture', { async request() {
    turn++
    return { text: turn === 2 ? 'Inspected partial batch.' : '', toolCalls: turn === 1 ? [{ id: 'batch', name: 'tool_batch', args: { calls: [
      { name: 'write', args: { path: 'first.txt', content: 'preserved' } },
      { name: 'bash', args: { command: 'node -e "process.stdout.write(1)"' } },
      { name: 'write', args: { path: 'last.txt', content: 'must not run' } }
    ] } }] : [], usage: { input: 1, output: 1 }, stopReason: turn === 1 ? 'tool_use' : 'end_turn' }
  }, async *requestStream() { throw new Error('stream disabled') } })
  const result = await kernel.executeTurn({ sessionId: 'batch', prompt: 'Perform the operations', model: 'test', providerType: 'fixture' })
  assert.equal(result.reply, 'Inspected partial batch.')
  assert.equal(await readFile(path.join(root, 'first.txt'), 'utf8'), 'preserved')
  await assert.rejects(readFile(path.join(root, 'last.txt')), { code: 'ENOENT' })
  assert.equal(approvals, 1)
  assert.match(result.toolEvents[0].output, /permission denied/)
  const report = await kernel.diagnostics.inspectPrompt('batch')
  assert.ok(report.context.components.system > 0); assert.ok(report.blocks.every(block => block.fingerprint && block.source))
  assert.equal(JSON.stringify(report).includes('must not run'), false)
})

test('a tool that may have performed its side effect cannot be blindly replayed after interruption', async t => {
  const { root } = await fixture(t)
  let executions = 0
  const tool = { name: 'custom_mutation', inputSchema: { type: 'object' }, async execute() { executions++; await writeFile(path.join(root, 'side-effect.txt'), 'happened'); throw new Error('transport lost after side effect') } }
  const input = { tool, args: { purpose: 'fixture' }, sessionId: 'interrupted', turnId: 'one', context: { cwd: root, config: {} } }
  await executeTool(input)
  const second = await executeTool({ ...input, turnId: 'two' })
  assert.equal(executions, 1); assert.equal(second.code, 'tool_outcome_unknown')
  const [row] = await listToolOperations('interrupted')
  assert.equal(row.state, 'uncertain'); assert.equal(row.fingerprint, undefined)
  await assert.rejects(resolveToolOperation('interrupted', row.id), /Inspect/)
  await resolveToolOperation('interrupted', row.id, true)
  await executeTool({ ...input, turnId: 'three' }); assert.equal(executions, 2)
  const live = await beginToolOperation({ sessionId: 'live', turnId: 'one', tool: 'write', args: {} })
  await assert.rejects(resolveToolOperation('live', live.id, true), /still be executing/)
  await live.finish('settled')
})

test('hook-injected request content participates in the preflight budget and prevents an oversized provider request', async t => {
  const { kernel, root, config } = await fixture(t)
  config.provider.fixture.context_limit = 16000; config.provider.fixture.max_tokens = 1024
  const hooks = path.join(root, '.kkcode', 'hooks'); await mkdir(hooks, { recursive: true })
  await writeFile(path.join(hooks, 'inflate.mjs'), 'export default {chat:{messagesTransform:messages=>[...messages,{role:"user",content:"x".repeat(100000)}]}}')
  let requests = 0
  kernel.providers.registerProvider('fixture', { async request() { requests++; return { text: 'unexpected', usage: {} } }, async *requestStream() { throw new Error('unexpected') } })
  const result = await kernel.executeTurn({ sessionId: 'hook-budget', prompt: 'hello', model: 'test', providerType: 'fixture' })
  assert.match(result.error, /Context budget exceeded/)
  assert.equal(requests, 0)
  assert.ok((await kernel.sessions.getSession('hook-budget')).session.context.components.messages > 16000)
})

test('encrypted credentials resist tampering and preserve concurrent independent updates', async t => {
  const { root } = await fixture(t)
  const store = encryptedStore('fixture-namespace', path.join(root, 'vault'))
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.update(value => ({ ...value, [i]: `secret-${i}` }))))
  assert.equal(Object.keys(await store.read()).length, 8)
  const { readdir } = await import('node:fs/promises')
  const file = path.join(root, 'vault', (await readdir(path.join(root, 'vault'))).find(name => name.endsWith('.enc')))
  const bytes = await readFile(file); assert.equal(bytes.includes('secret-'), false)
  bytes[bytes.length - 1] ^= 1; await writeFile(file, bytes)
  await assert.rejects(store.read(), /could not be opened/)
  const parallelRoot = path.join(root, 'parallel-vault')
  const namespaces = Array.from({ length: 8 }, (_, i) => encryptedStore(`namespace-${i}`, parallelRoot))
  await Promise.all(namespaces.map((store, i) => store.update(() => ({ value: i }))))
  assert.deepEqual(await Promise.all(namespaces.map(async store => (await store.read()).value)), [0, 1, 2, 3, 4, 5, 6, 7])
})
