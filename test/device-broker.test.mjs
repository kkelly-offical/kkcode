import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DeviceService } from '../src/device/service.mjs'
import { createPromptQueue } from '../src/repl/prompt-queue.mjs'

async function fixture(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kkcode-broker-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = home
  const service = await new DeviceService({ cwd: home, roots: [home] }).initialize()
  try { await run(service, home) } finally { await service.close(); if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(home, { recursive: true, force: true }) }
}

test('remote approval cancels the local prompt and rejects a second decision', () => fixture(async service => {
  let localSignal
  const answer = service.ask('permission', { sessionId: 'session', tool: 'write' }, request => { localSignal = request.signal; return new Promise(() => {}) })
  for (let i = 0; i < 100 && !localSignal; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(localSignal)
  const id = [...service.approvals.keys()][0]
  await service.request({ id: 'different-client-answer', method: 'approvals.resolve', params: { sessionId: 'session', id, answer: 'allow_once' } }, { id: 'local', client: 'another-client' })
  assert.equal(await answer, 'allow_once'); assert.equal(localSignal.aborted, true)
  assert.throws(() => service.resolveApproval(id, 'deny'), error => error.code === 'approval_closed')
  assert.equal(service.approvals.size, 0)
}))

test('cancelling a turn settles its pending question without waiting for the five-minute timeout', () => fixture(async service => {
  const controller = new AbortController()
  service.turns.set('question-session', { controller })
  const pending = service.ask('question', { sessionId: 'question-session', questions: [{ id: 'choice', text: 'Continue?' }] })
  controller.abort()
  assert.deepEqual(await pending, {}); assert.equal(service.approvals.size, 0)
  service.turns.delete('question-session')
}))

test('kernel and kernel.turns entry points share one broker, emit results and restore on close', () => fixture(async (service, cwd) => {
  let resolve, calls = 0
  const original = () => { calls++; return new Promise(done => { resolve = done }) }
  const kernel = { cwd, executeTurn: original, turns: { executeTurn: original }, events: { subscribe: () => () => {} }, prompts: { permission: { setPermissionPromptInterceptor() {} }, question: { setQuestionPromptInterceptor() {} } }, async shutdown() {} }
  service.attachKernel(kernel)
  assert.equal(kernel.executeTurn, kernel.turns.executeTurn)
  const turn = kernel.turns.executeTurn({ sessionId: 'tracked-session' })
  await assert.rejects(kernel.executeTurn({ sessionId: 'tracked-session' }), error => error.code === 'turn_busy')
  assert.equal(calls, 1); assert.equal(service.turns.size, 1)
  resolve({ reply: 'done', turnId: 'turn' }); await turn
  assert.equal(service.turns.size, 0); assert.equal(service.leases.size, 0)
  assert.equal((await service.readEvents('tracked-session', 0)).at(-1).type, 'turn.result')
  await service.close(); assert.equal(kernel.executeTurn, original); assert.equal(kernel.turns.executeTurn, original)
}))

test('synchronous kernel errors cannot leave the session permanently busy', () => fixture(async (service, cwd) => {
  const kernel = { cwd, executeTurn() { throw new Error('synchronous failure') }, events: { subscribe: () => () => {} }, prompts: { permission: { setPermissionPromptInterceptor() {} }, question: { setQuestionPromptInterceptor() {} } }, async shutdown() {} }
  service.attachKernel(kernel)
  await assert.rejects(kernel.executeTurn({ sessionId: 'failed' }), /synchronous failure/)
  assert.equal(service.turns.size, 0); assert.equal(service.leases.size, 0)
}))

test('TUI cancellation removes queued and active prompts without cancelling their neighbours', () => {
  const ui = { permissionQueue: [], pendingPermission: null }, resolved = []
  const queue = createPromptQueue({ ui, requestRender() {} })
  const first = new AbortController(), second = new AbortController()
  queue.queuePermissionPrompt({ tool: 'write', signal: first.signal, resolve: answer => resolved.push(['first', answer]) })
  queue.queuePermissionPrompt({ tool: 'edit', signal: second.signal, resolve: answer => resolved.push(['second', answer]) })
  queue.queuePermissionPrompt({ tool: 'bash', resolve: answer => resolved.push(['third', answer]) })
  second.abort(); assert.equal(ui.permissionQueue.length, 1)
  first.abort(); assert.equal(ui.pendingPermission.tool, 'bash')
  queue.resolvePermissionPrompt('allow_once')
  assert.deepEqual(resolved, [['second', 'deny'], ['first', 'deny'], ['third', 'allow_once']])
})
