import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createKernel, getSession } from '../src/kernel/index.mjs'
import { appendUserMessage, appendAssistantMessage, updateSession } from '../src/kernel/session/store.mjs'
import { DeviceService } from '../src/device/service.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function fixture(t, summarize) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-manual-compact-')), cwd = path.join(root, 'repo')
  await mkdir(cwd)
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = path.join(root, 'state')
  const service = await new DeviceService({ cwd, roots: [cwd], createKernelImpl: async options => {
    const kernel = await createKernel({ ...options, trustState: { trusted: true } })
    const config = kernel.configState.config
    config.provider.default = 'fixture'; config.provider.fixture = { default_model: 'fixture', retry_attempts: 0 }
    config.skills.auto_seed = false; config.mcp.auto_discover = false
    kernel.providers.registerProvider('fixture', { request: summarize, async *requestStream() { assert.fail('compact cannot run a conversation turn') } })
    return kernel
  } }).initialize()
  t.after(async () => { await service.close(); if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  const principal = { id: 'local', client: 'browser' }
  const rpc = (method, params = {}) => service.request({ id: randomUUID(), method, params }, principal)
  const { id: sessionId } = await rpc('sessions.create', { cwd })
  for (let i = 0; i < 12; i++) {
    await appendUserMessage(sessionId, `Question ${i}`, { turnId: `turn-${i}` })
    await appendAssistantMessage(sessionId, `Answer ${i} ` + 'context details '.repeat(2000), { turnId: `turn-${i}` })
  }
  await updateSession(sessionId, { context: { tokens: 100000, limit: 200000, provider: 'fixture', model: 'fixture', source: 'provider-usage', components: { system: 200, tools: 400 } } })
  await rpc('control.acquire', { sessionId })
  return { service, sessionId, rpc, principal }
}

test('manual compact acknowledges once, is cancellable during provider work and keeps original history/meter', { timeout: 15000 }, async t => {
  const entered = deferred(), release = deferred(); let calls = 0, signal
  const f = await fixture(t, async input => { calls++; signal = input.signal; entered.resolve(); await release.promise; return { text: 'Concise summary', usage: { input: 10, output: 5 } } })
  const original = await getSession(f.sessionId)
  const request = { id: randomUUID(), method: 'commands.run', params: { sessionId: f.sessionId, command: '/compact', executionId: 'compact-first' } }
  const accepted = await f.service.request(request, f.principal)
  assert.equal(accepted.accepted, true)
  assert.equal(accepted.operation, 'compact')
  await entered.promise
  const finished = f.service.turns.get(f.sessionId).promise
  assert.deepEqual(await f.service.request(request, f.principal), accepted)
  await assert.rejects(f.rpc('commands.run', { sessionId: f.sessionId, command: '/compact' }), { code: 'turn_busy' })
  await assert.rejects(f.rpc('turns.steer', { sessionId: f.sessionId, executionId: accepted.executionId, prompt: 'Hello' }), { code: 'session_busy' })
  await assert.rejects(f.rpc('turns.cancel', { sessionId: f.sessionId, executionId: 'stale' }), { code: 'turn_changed' })
  const stopped = await f.rpc('turns.cancel', { sessionId: f.sessionId, executionId: accepted.executionId })
  assert.equal(stopped.turnState.phase, 'stopping')
  assert.equal(signal.aborted, true)
  release.resolve(); await finished
  const saved = await getSession(f.sessionId)
  assert.deepEqual(saved.messages, original.messages)
  assert.deepEqual(saved.session.context, original.session.context)
  const events = await f.service.readEvents(f.sessionId, 0)
  assert.equal(events.filter(event => event.type === 'session.compacted').length, 0)
  assert.equal(events.at(-1).type, 'turn.cancelled')
  assert.equal(events.at(-1).payload.operation, 'compact')
  assert.equal(calls, 1)
  assert.equal(f.service.turns.size, 0)
})

test('successful manual compact immediately persists/pushes a smaller estimated context and arrow values', async t => {
  const f = await fixture(t, async () => ({ text: 'Concise summary with the original questions retained.', usage: { input: 10, output: 5 } }))
  const accepted = await f.rpc('commands.run', { sessionId: f.sessionId, command: '/compact' })
  await f.service.turns.get(f.sessionId).promise
  const events = await f.service.readEvents(f.sessionId, 0)
  const context = events.find(event => event.type === 'session.context.updated')?.payload.context
  const compact = events.find(event => event.type === 'session.compacted')?.payload
  assert.equal(compact.beforeTokens, 100000)
  assert.ok(context.tokens < 100000)
  assert.equal(context.tokens, compact.afterTokens)
  assert.equal(context.source, 'estimated')
  assert.equal(context.components.system, 200)
  assert.equal(context.components.tools, 400)
  const snapshot = await f.rpc('sessions.get', { sessionId: f.sessionId })
  assert.equal(snapshot.context.tokens, context.tokens)
  assert.equal(snapshot.lastCompaction.afterTokens, context.tokens)
  assert.equal(snapshot.running, false)
  assert.equal(snapshot.messages[0].compaction.beforeTokens, 100000)
  assert.equal(events.at(-1).type, 'turn.result')
  assert.equal(events.at(-1).payload.executionId, accepted.executionId)
})

test('compact can stop during kernel preparation without dispatching a late provider request', async t => {
  let calls = 0
  const f = await fixture(t, async () => { calls++; return {text: 'Unexpected summary'} })
  const entered = deferred(), release = deferred(), original = f.service.kernel.bind(f.service)
  f.service.kernel = async (...args) => { entered.resolve(); await release.promise; return original(...args) }
  try {
    const accepted = await f.rpc('commands.run', {sessionId: f.sessionId, command: '/compact', executionId: 'compact-preparing'})
    const done = f.service.turns.get(f.sessionId).promise
    await entered.promise
    await f.rpc('turns.cancel', {sessionId: f.sessionId, executionId: accepted.executionId})
    await done
    assert.equal(calls, 0)
    release.resolve()
    assert.equal((await f.service.readEvents(f.sessionId, 0)).at(-1).type, 'turn.cancelled')
    assert.equal((await getSession(f.sessionId)).messages.length, 24)
  } finally { release.resolve() }
})
