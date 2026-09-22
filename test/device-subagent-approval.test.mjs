import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createKernel } from '../src/kernel/index.mjs'
import { currentRuntime } from '../src/kernel/core/runtime-context.mjs'
import { DeviceService } from '../src/device/service.mjs'

async function until(read, description) {
  // Real kernel boot + journal fsync is noticeably slower under Windows
  // coverage/parallel CI. Keep a bounded deadline, not a fixed sleep or retry
  // of the test; assertions must still observe the original pending approval.
  const deadline = Date.now() + 30000
  do { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)) } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for ${description}`)
}

async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kkcode-device-subagents-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(directory, 'state')
  const calls = new Map(), parents = new Set()
  const service = await new DeviceService({ cwd: directory, roots: [directory], createKernelImpl: async options => {
    const kernel = await createKernel({ ...options, trust: true })
    const config = kernel.configState.config
    config.provider.default = 'fixture'; config.provider.fixture = { default_model: 'fixture', stream: false, retry_attempts: 0 }
    config.skills.auto_seed = false; config.mcp.auto_discover = false
    config.tool.sources = { builtin: true, local: false, plugin: false, mcp: false }
    config.permission.level = 'manual'; config.permission.rules = []; config.permission.non_tty_default = 'deny'
    config.agent.verify_completion = false
    config.agent.subagents = { 'tdd-guide': { permission: 'full', tools: ['write', 'question'] } }
    kernel.providers.registerProvider('fixture', { async request() {
      const id = currentRuntime().sessionId, count = (calls.get(id) || 0) + 1
      calls.set(id, count)
      if (parents.has(id) && count === 1) return { text: '', usage: {}, toolCalls: [{ id: `delegate_${id}`, name: 'task', args: { prompt: 'Write and ask one fixture question.', subagent_type: 'tdd-guide', allow_question: true } }] }
      if (!parents.has(id) && count === 1) return { text: '', usage: {}, toolCalls: [
        // Use the session workspace coordinate system: macOS /var aliases and
        // Windows 8.3 temp paths differ from DeviceService's canonical cwd.
        { id: `write_${id}`, name: 'write', args: { path: `${currentRuntime().parentSessionId}.txt`, content: 'approved child write' } },
        { id: `question_${id}`, name: 'question', args: { questions: [{ id: 'choice', text: 'Continue?', options: [{ label: 'Continue', value: 'continue' }] }] } }
      ] }
      return { text: 'done', toolCalls: [], usage: {} }
    }, async *requestStream() { yield { type: 'text', content: 'unexpected stream' } } })
    return kernel
  } }).initialize()
  const principalA = { id: 'local', client: 'browser-A' }, principalB = { id: 'local', client: 'browser-B' }
  const rpc = (method, params, principal = principalA) => service.request({ id: randomUUID(), method, params }, principal)
  const start = async () => {
    const session = await rpc('sessions.create', { cwd: directory }); parents.add(session.id)
    await rpc('control.acquire', { sessionId: session.id })
    await rpc('turns.start', { sessionId: session.id, prompt: 'Delegate the test.', provider: 'fixture', model: 'fixture' })
    return session.id
  }
  const next = predicate => until(async () => {
    const approval = [...service.approvals.values()].find(predicate)
    if (approval) return approval
    if (!service.turns.size) {
      const sessionId = [...parents].at(-1)
      const final = sessionId ? (await service.readEvents(sessionId, 0)).at(-1) : null
      throw new Error(`Parent ended before the expected approval: ${final?.type || 'no terminal event'} / ${final?.payload?.status || 'unknown status'}`)
    }
  }, 'approval')
  const resolve = (sessionId, approval, answer) => rpc('approvals.resolve', { sessionId, id: approval.id, answer }, principalB)
  try { await run({ service, rpc, start, next, resolve, directory, principalB }) } finally {
    await service.close()
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(directory, { recursive: true, force: true })
  }
}

test('another authenticated client approves child write and question from the parent session only', { timeout: 90000 }, () => fixture(async ({ service, rpc, start, next, resolve, directory, principalB }) => {
  const sessionId = await start()
  const delegation = await next(a => a.request.tool === 'task')
  await resolve(sessionId, delegation, 'allow_once')
  const childWrite = await next(a => a.request.tool === 'write')
  assert.equal(childWrite.sessionId, sessionId)
  assert.notEqual(childWrite.request.originSessionId, sessionId)
  assert.equal(childWrite.request.parentSessionId, sessionId)
  const snapshot = await rpc('events.list', { sessionId, after: 0 }, principalB)
  assert.ok(snapshot.approvals.some(a => a.id === childWrite.id && a.request.sourceSessionId === childWrite.request.originSessionId))
  assert.equal(snapshot.control.yours, false)
  await assert.rejects(rpc('approvals.resolve', { sessionId: childWrite.request.originSessionId, id: childWrite.id, answer: 'allow_once' }, principalB), error => error.code === 'approval_session_mismatch')
  await resolve(sessionId, childWrite, 'allow_once')
  assert.throws(() => service.resolveApproval(childWrite.id, 'allow_always'), error => error.code === 'approval_closed')
  const question = await next(a => a.kind === 'question')
  assert.equal(question.sessionId, sessionId); assert.equal(question.request.originSessionId, childWrite.request.originSessionId)
  await resolve(sessionId, question, { choice: 'continue' })
  await until(() => !service.turns.has(sessionId), 'completed parent turn')
  const child = await rpc('sessions.get', { sessionId: childWrite.request.originSessionId })
  const writeResult = child.parts.find(part => part.tool === 'write' && part.status !== 'running')
  assert.equal(writeResult?.status, 'completed', writeResult?.output || 'Missing child write result')
  assert.equal(await readFile(path.join(directory, `${sessionId}.txt`), 'utf8'), 'approved child write')
  const events = await service.readEvents(sessionId, 0)
  assert.equal(events.filter(event => event.type === 'approval.requested').length, 3)
  assert.equal(events.filter(event => event.type === 'approval.resolved').length, 3)
  // Session metadata (e.g. the asynchronous first-question title) may arrive
  // after the turn. It must not change the terminal turn lifecycle itself.
  assert.equal(events.filter(event => event.type.startsWith('turn.')).at(-1).type, 'turn.result')
}))

test('parent cancellation denies a pending child write and removes every cross-client approval', { timeout: 90000 }, () => fixture(async ({ service, rpc, start, next, resolve, directory }) => {
  const sessionId = await start()
  await resolve(sessionId, await next(a => a.request.tool === 'task'), 'allow_once')
  const childWrite = await next(a => a.request.tool === 'write')
  await rpc('turns.cancel', { sessionId })
  await until(() => !service.turns.has(sessionId), 'cancelled parent turn')
  assert.equal(service.approvals.size, 0)
  await assert.rejects(readFile(path.join(directory, `${sessionId}.txt`)), error => error.code === 'ENOENT')
  assert.throws(() => service.resolveApproval(childWrite.id, 'allow_once'), error => error.code === 'approval_closed')
  const final = (await service.readEvents(sessionId, 0)).at(-1)
  assert.equal(final.type, 'turn.result')
  assert.match(final.payload.error, /cancel|abort/i)
}))
