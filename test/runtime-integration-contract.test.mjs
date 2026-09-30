import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createKernel } from '../src/kernel/kernel.mjs'
import { createRunSpec } from '../src/kernel/orchestration/run-spec.mjs'

async function fixture(t, { onEvent, verifyCompletion = true, titleGeneration = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-runtime-integration-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  const kernels = [], calls = []
  t.after(async () => {
    await Promise.allSettled(kernels.map(kernel => kernel.shutdown()))
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  })
  const make = async name => {
    const cwd = path.join(root, name); await mkdir(cwd)
    const kernel = await createKernel({ cwd, trustState: { trusted: true }, handlers: { onEvent }, config: { config: {
      provider: { default: 'integration-fixture', 'integration-fixture': { default_model: 'fixture', retry_attempts: 0 } },
      agent: { max_steps: 5, verify_completion: verifyCompletion }, permission: { level: 'yolo', rules: [] },
      tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } },
      session: { title_generation: titleGeneration, recovery: false }, usage: { budget: {} }, ui: { markdown_render: false }
    } } })
    kernels.push(kernel)
    kernel.providers.registerProvider('integration-fixture', {
      async request(input) { calls.push(input); return { text: 'Controlled fixture reply.', toolCalls: [], usage: { input: 1, output: 1 } } },
      async *requestStream(input) { calls.push(input); yield { type: 'text', content: 'Controlled fixture reply.' } }
    })
    return kernel
  }
  return { kernel: await make('a'), make, calls }
}

test('SDK child controller callbacks retain their kernel after the factory await', async t => {
  const { kernel, make, calls } = await fixture(t)
  const foreign = await make('b')
  await kernel.sessions.touchSession({ sessionId: 'sdk-parent', cwd: kernel.cwd, mode: 'agent', model: 'fixture', providerType: 'integration-fixture' })
  const controller = await kernel.agents.forSession('sdk-parent')
  const created = await foreign.run(() => controller.create({ prompt: 'bounded read-only inspection', subagent_type: 'explore', budget_usd: 0 }))
  assert.equal(created.status, 'incomplete')
  const child = (await kernel.sessions.getSession(created.session_id)).session
  assert.equal(child.childContract.runSpec.workspace.cwd, kernel.cwd)
  assert.equal(child.cwd, kernel.cwd)
  const resumed = await controller.followup(created.session_id, 'inspect only')
  assert.equal(resumed.status, 'incomplete')
  assert.equal(resumed.stop_reason, 'budget')
  assert.equal(calls.length, 0)
  await assert.rejects(foreign.agents.forSession('sdk-parent'), /workspace/)
})

test('SDK Todo callbacks emit on their owning kernel outside or inside a foreign runtime', async t => {
  const { kernel, make } = await fixture(t)
  const foreign = await make('b'), ownEvents = [], foreignEvents = []
  await kernel.sessions.touchSession({ sessionId: 'todo-parent', cwd: kernel.cwd, mode: 'agent', model: 'fixture', providerType: 'integration-fixture' })
  const service = await kernel.todos.forSession('todo-parent')
  const unsubOwn = kernel.events.subscribe(event => { if (event.type === 'todo.updated') ownEvents.push(event) })
  const unsubForeign = foreign.events.subscribe(event => { if (event.type === 'todo.updated') foreignEvents.push(event) })
  t.after(() => { unsubOwn(); unsubForeign() })
  await service.update({ todos: [{ content: 'inspect', status: 'pending' }] })
  await foreign.run(() => service.update({ todos: [{ content: 'inspect', status: 'completed' }] }))
  assert.equal(ownEvents.length, 2)
  assert.equal(foreignEvents.length, 0)
  assert.ok(ownEvents.every(event => event.sessionId === 'todo-parent'))
  assert.equal((await kernel.todos.list('todo-parent')).revision, 2)
  const viaTool = await kernel.tools.call('todowrite', { todos: [{ content: 'inspect', status: 'completed' }] }, {
    cwd: kernel.cwd, sessionId: 'todo-parent', config: kernel.configState.config, todoService: service
  })
  assert.equal(viaTool.ok, true, 'SDK-bound capability retains its private host brand when handed to a builtin')
})

test('zero-budget child makes no model or title requests through the actual kernel', async t => {
  const { kernel, calls } = await fixture(t, { titleGeneration: true })
  const runSpec = createRunSpec({ sessionId: 'zero-budget', parentSessionId: 'budget-parent', role: { name: 'explore', permission: 'readonly' },
    workspace: { cwd: kernel.cwd, root: kernel.cwd, writeScope: 'read-only' }, limits: { budgetUsd: 0 } })
  const result = await kernel.executeTurn({ prompt: 'Do not spend', sessionId: 'zero-budget', model: 'fixture', providerType: 'integration-fixture', runSpec })
  assert.equal(result.status, 'incomplete')
  assert.equal(result.stopReason, 'budget')
  assert.equal(calls.length, 0)
})

for (const boundary of ['stream.end', 'turn.usage.update', 'session.context.updated']) {
  test(`abort at ${boundary} cannot publish a completed terminal`, async t => {
    const controller = new AbortController(), terminals = []
    let streamed = false
    const { kernel, calls } = await fixture(t, { onEvent: event => {
      if (event.type === 'stream.end') streamed = true
      if (event.type === boundary && (boundary !== 'session.context.updated' || streamed)) controller.abort()
      if (['turn.finish', 'turn.error'].includes(event.type)) terminals.push(event)
    } })
    const result = await kernel.executeTurn({ prompt: 'controlled late abort', sessionId: 'late-abort', model: 'fixture', providerType: 'integration-fixture', signal: controller.signal })
    assert.equal(controller.signal.aborted, true)
    assert.equal(result.status, 'cancelled')
    assert.equal(result.cancelled, true)
    assert.equal(calls.length, 1)
    assert.ok(terminals.some(event => event.type === 'turn.error' && event.payload.cancelled))
    assert.equal(terminals.some(event => event.type === 'turn.finish' && event.payload.status === 'completed'), false)
    const saved = await kernel.sessions.getSession('late-abort')
    assert.ok(saved.parts.some(part => part.type === 'turn-cancelled'))
  })
}

for (const verifyCompletion of [true, false]) test(`actual parent tool loop cannot convert a zero-budget child into completed work (verify_completion=${verifyCompletion})`, async t => {
  const { kernel } = await fixture(t, { verifyCompletion })
  let requests = 0
  kernel.providers.registerProvider('integration-fixture', {
    async request() { throw new Error('Only controlled streaming is enabled') },
    async *requestStream() {
      if (++requests === 1) yield { type: 'tool_call', call: { id: 'bounded-child', name: 'task', args: { prompt: 'bounded inspection', subagent_type: 'explore', budget_usd: 0 } } }
      else yield { type: 'text', content: 'Everything is done.' }
    }
  })
  const result = await kernel.executeTurn({ prompt: 'delegate bounded work', sessionId: 'parent-loop', model: 'fixture', providerType: 'integration-fixture' })
  const childTool = result.toolEvents.find(event => event.name === 'task')
  assert.equal(childTool.ok, false)
  assert.equal(childTool.status, 'blocked')
  assert.equal(childTool.metadata.childOutcome.status, 'incomplete')
  assert.equal(result.status, 'incomplete')
  assert.equal(result.verification.passed, false)
})
