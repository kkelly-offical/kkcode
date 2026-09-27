import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createKernel, getSession } from '../src/kernel/index.mjs'
import { DeviceService } from '../src/device/service.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function fixture(t, provider, configure = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-cancel-recovery-')), cwd = path.join(root, 'repo')
  await mkdir(cwd)
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = path.join(root, 'state')
  const service = await new DeviceService({ cwd, roots: [cwd], createKernelImpl: async options => {
    const kernel = await createKernel({ ...options, trustState: { trusted: true } })
    const config = kernel.configState.config
    config.language = 'zh'; config.provider.default = 'fixture'; config.provider.fixture = { default_model: 'fixture', stream: true, retry_attempts: 0 }
    config.skills.auto_seed = false; config.mcp.auto_discover = false
    config.tool.sources = { builtin: false, local: false, plugin: false, mcp: false }
    config.agent.verify_completion = false; config.session.title_generation = false
    configure(config)
    kernel.providers.registerProvider('fixture', { async request() { assert.fail('expected controlled streaming fixture') }, async *requestStream() { assert.fail('expected controlled non-streaming fixture') }, ...provider })
    return kernel
  } }).initialize()
  t.after(async () => { await service.close(); if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  const principal = { id: 'local', client: 'browser' }
  const rpc = (method, params = {}) => service.request({ id: randomUUID(), method, params }, principal)
  const { id: sessionId } = await rpc('sessions.create', { cwd })
  const acquire = () => rpc('control.acquire', { sessionId })
  await acquire()
  return { service, sessionId, rpc, acquire, cwd }
}

test('stop preserves partial reasoning/text and settles resources before a new turn can start', { timeout: 20000 }, async t => {
  const entered = deferred(), cancelled = deferred(); let calls = 0
  const f = await fixture(t, { async *requestStream({ signal }) {
    calls++
    if (calls > 1) { yield { type: 'text', content: '继续后的回复' }; return }
    yield { type: 'thinking', content: '已收到的思考' }
    yield { type: 'text', content: '尚未完成的正文' }
    entered.resolve()
    await new Promise((_, reject) => {
      const stop = () => { cancelled.resolve(); reject(signal.reason) }
      if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true })
    })
  } })
  const accepted = await f.rpc('turns.start', { sessionId: f.sessionId, prompt: '开始' })
  const completion = f.service.turns.get(f.sessionId).promise
  await entered.promise
  const stop = await f.rpc('turns.cancel', { sessionId: f.sessionId, executionId: accepted.executionId })
  assert.equal(stop.cancelled, true)
  await cancelled.promise; await completion
  assert.equal(f.service.turns.size, 0)
  assert.equal(f.service.leases.size, 0)
  const events = await f.service.readEvents(f.sessionId, 0)
  assert.equal(events.at(-1).type, 'turn.cancelled')
  assert.equal(events.at(-1).payload.reply, '尚未完成的正文')
  assert.ok(events.some(row => row.type === 'turn.stopping'))
  assert.equal(events.filter(row => row.type === 'turn.failed').length, 0)
  const snapshot = await f.rpc('sessions.get', { sessionId: f.sessionId })
  assert.equal(snapshot.running, false)
  assert.equal(snapshot.turnState, null)
  assert.ok(snapshot.parts.some(part => part.type === 'turn-cancelled'))
  assert.ok(snapshot.messages.some(message => message.interrupted && message.content.some(block => block.text === '尚未完成的正文')))
  const stored = await getSession(f.sessionId)
  assert.equal(stored.session.retryMeta.inProgress, false)
  assert.equal(stored.parts.some(part => part.type === 'provider-error'), false)
  await f.acquire()
  await f.rpc('turns.start', { sessionId: f.sessionId, prompt: '继续，先核查已有结果' })
  await f.service.turns.get(f.sessionId).promise
  assert.equal(calls, 2, 'cancellation must not retry the provider or replay the old turn')
  assert.equal((await f.service.readEvents(f.sessionId, 0)).at(-1).type, 'turn.result')
})

test('stop interrupts shared kernel preparation without later dispatching the cancelled prompt', { timeout: 10000 }, async t => {
  let calls = 0
  const f = await fixture(t, { async *requestStream() { calls++; yield { type: 'text', content: 'unexpected' } } })
  const entered = deferred(), gate = deferred(), original = f.service.kernel.bind(f.service)
  f.service.kernel = async (...args) => { entered.resolve(); await gate.promise; return original(...args) }
  const started = f.rpc('turns.start', { sessionId: f.sessionId, prompt: '尚在准备', executionId: 'prepared-fixture' })
  try {
    await entered.promise
    await f.rpc('turns.cancel', { sessionId: f.sessionId, executionId: 'prepared-fixture' })
    const result = await started
    assert.equal(result.cancelled, true); assert.equal(result.accepted, false)
    assert.equal(f.service.turns.has(f.sessionId), false)
    assert.equal(calls, 0)
  } finally { gate.resolve(); f.service.kernel = original }
})

test('provider-local AbortError without caller cancellation remains a real failure', async t => {
  const f = await fixture(t, { async *requestStream() {
    yield { type: 'thinking', content: 'provider timeout fixture' }
    throw new DOMException('provider timeout', 'AbortError')
  } })
  await f.rpc('turns.start', { sessionId: f.sessionId, prompt: 'timeout' })
  await f.service.turns.get(f.sessionId).promise
  const events = await f.service.readEvents(f.sessionId, 0)
  assert.equal(events.some(row => row.type === 'turn.cancelled'), false)
  assert.match(events.at(-1).payload.error, /provider timeout/)
  const stored = await getSession(f.sessionId)
  assert.ok(stored.parts.some(part => part.type === 'provider-error'))
})

test('a delayed stop bound to an older execution cannot cancel the next one', async t => {
  const f = await fixture(t, { async *requestStream() { yield { type: 'text', content: 'unused' } } })
  const controller = new AbortController()
  f.service.turns.set(f.sessionId, { controller, turnId: 'new-execution', client: 'browser', phase: 'running' })
  await assert.rejects(f.rpc('turns.cancel', { sessionId: f.sessionId, executionId: 'old-execution' }), { code: 'turn_changed' })
  assert.equal(controller.signal.aborted, false)
  await f.rpc('turns.cancel', { sessionId: f.sessionId, executionId: 'new-execution' })
  assert.equal(controller.signal.aborted, true)
  assert.equal((await f.rpc('events.list', { sessionId: f.sessionId })).turnState.phase, 'stopping')
  const oldEntry = { client: 'browser' }
  f.service.finishTurn(f.sessionId, oldEntry)
  assert.ok(f.service.turns.has(f.sessionId), 'old finalizers cannot clear a new turn or its control lease')
  f.service.turns.delete(f.sessionId)
  assert.equal((await f.rpc('turns.cancel', { sessionId: f.sessionId })).running, false)
})

test('cancellation after a file edit keeps the real effect and paired tool results without another inference', { timeout: 30000 }, async t => {
  let calls = 0
  const f = await fixture(t, {
    async request() {
      calls++
      return calls === 1 ? { text: '', toolCalls: [{ id: 'write-before-stop', name: 'write', args: { path: 'kept.txt', content: 'already executed' } }], usage: {} }
        : { text: '核查并继续', toolCalls: [], usage: {} }
    },
  }, config => { config.provider.fixture.stream = false; config.tool.sources.builtin = true })
  let interrupted = false
  f.service.on('event', row => {
    if(row.type === 'tool.finish' && row.payload.tool === 'write' && !interrupted) {
      interrupted = true
      f.service.turns.get(f.sessionId).controller.abort()
    }
  })
  await f.rpc('turns.start', { sessionId: f.sessionId, prompt: '写一个文件', mode: 'yolo' })
  await f.service.turns.get(f.sessionId).promise
  assert.equal(interrupted, true)
  assert.equal(calls, 1, 'no provider continuation after stop')
  assert.equal(await readFile(path.join(f.cwd, 'kept.txt'), 'utf8'), 'already executed')
  const stored = await getSession(f.sessionId)
  const blocks = stored.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
  assert.ok(blocks.some(block => block.type === 'tool_use' && block.id === 'write-before-stop'))
  assert.ok(blocks.some(block => block.type === 'tool_result' && block.tool_use_id === 'write-before-stop'))
  assert.equal((await f.service.readEvents(f.sessionId, 0)).at(-1).type, 'turn.cancelled')
  await f.acquire()
  await f.rpc('turns.start', { sessionId: f.sessionId, prompt: '核查已有结果再继续', mode: 'yolo' })
  await f.service.turns.get(f.sessionId).promise
  assert.equal(calls, 2)
  assert.equal(await readFile(path.join(f.cwd, 'kept.txt'), 'utf8'), 'already executed')
})

test('attachment cleanup completes before cancellation is advertised and failures remain visible', { timeout: 15000 }, async t => {
  const entered = deferred(), cleanup = deferred(), release = deferred()
  const f = await fixture(t, { async *requestStream({ signal }) {
    yield { type: 'text', content: 'partial' }; entered.resolve()
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  const resolve = f.service.attachments.resolve.bind(f.service.attachments)
  f.service.attachments.resolve = async options => {
    const input = await resolve(options)
    return { ...input, release: async () => { cleanup.resolve(); await release.promise; await input.release(); throw new Error('fixture cleanup failure') } }
  }
  try {
    await f.rpc('turns.start', { sessionId: f.sessionId, prompt: 'cleanup' })
    const completion = f.service.turns.get(f.sessionId).promise
    await entered.promise
    await f.rpc('turns.cancel', { sessionId: f.sessionId })
    await cleanup.promise
    assert.equal(f.service.sessionState(f.sessionId).running, true)
    assert.equal(f.service.sessionState(f.sessionId).turnState.phase, 'stopping')
    assert.equal((await f.service.readEvents(f.sessionId, 0)).some(row => row.type === 'turn.cancelled'), false)
    await f.rpc('turns.cancel', { sessionId: f.sessionId })
    release.resolve(); await completion
    const events = await f.service.readEvents(f.sessionId, 0)
    assert.equal(events.filter(row => row.type === 'turn.stopping').length, 1)
    assert.equal(events.at(-1).type, 'turn.failed')
    assert.match(events.at(-1).payload.error, /cleanup failure/)
    assert.equal(f.service.sessionState(f.sessionId).running, false)
  } finally { release.resolve() }
})
