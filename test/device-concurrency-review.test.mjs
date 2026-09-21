import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createKernel } from '../src/kernel/index.mjs'
import { DeviceService } from '../src/device/service.mjs'
import { buildTranscript } from '../apps/web/src/transcript.mjs'

const execute = promisify(execFile)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('actual DeviceService serializes session transitions, commands and repository changes across clients', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kkcode-concurrency-review-')), previous = process.env.KKCODE_HOME
  const cwd = path.join(directory, 'repo'); await mkdir(cwd)
  process.env.KKCODE_HOME = path.join(directory, 'state'); await mkdir(process.env.KKCODE_HOME)
  const provider = { type: 'openai', base_url: 'http://127.0.0.1:9/v1', default_model: 'fixture-model', models: ['fixture-model'], stream: false, discovery: { enabled: false } }
  await writeFile(path.join(process.env.KKCODE_HOME, 'config.yaml'), JSON.stringify({ provider: { default: 'fixture', fixture: provider }, mcp: { auto_discover: false }, skills: { auto_seed: false } }))
  const git = async (...args) => (await execute('git', args, { cwd, windowsHide: true })).stdout.trimEnd()
  await git('init', '-b', 'main'); await git('config', 'user.name', 'KK Code Test'); await git('config', 'user.email', 'test@example.invalid')
  await writeFile(path.join(cwd, 'tracked.txt'), 'preserved\n'); await git('add', 'tracked.txt'); await git('-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'); await git('branch', 'other')
  const service = await new DeviceService({ cwd, roots: [directory], createKernelImpl: async options => {
    const kernel = await createKernel({ ...options, trust: true })
    kernel.configState.config.provider.default = 'fixture'; kernel.configState.config.provider.fixture = provider
    kernel.configState.config.skills.auto_seed = false; kernel.configState.config.mcp.auto_discover = false
    kernel.providers.registerProvider('fixture', { async request() { return { text: 'fixture reply', toolCalls: [], usage: {} } }, async *requestStream() { yield { type: 'text', content: 'fixture reply' } } })
    return kernel
  } }).initialize()
  const owner = { id: 'local', client: 'owner-browser' }, other = { id: 'local', client: 'another-owner-browser' }
  const rpc = (method, params = {}, principal = owner) => service.request({ id: randomUUID(), method, params }, principal)
  const originalKernel = service.kernel.bind(service)
  try {
    const { id: sessionId } = await rpc('sessions.create', { cwd })
    const kernel = await service.kernel(cwd)
    await rpc('control.acquire', { sessionId })
    const branch = await rpc('branches.list', { sessionId })
    const switchBranch = () => rpc('branches.switch', { sessionId, name: 'other', confirmed: true, stateToken: branch.stateToken })

    await t.test('configuration reserves the session before its first asynchronous kernel lookup', async () => {
      const entered = deferred(), gate = deferred()
      service.kernel = async (...args) => { entered.resolve(); await gate.promise; return originalKernel(...args) }
      const transition = rpc('sessions.configure', { sessionId, mode: 'plan', approval: 'readonly' })
      try {
        await entered.promise
        await assert.rejects(rpc('turns.start', { sessionId, prompt: 'must not run' }), { code: 'session_busy' })
        await assert.rejects(kernel.executeTurn({ sessionId, prompt: 'terminal must not run' }), { code: 'session_busy' })
        await assert.rejects(rpc('sessions.configure', { sessionId, mode: 'yolo' }), { code: 'session_busy' })
        await assert.rejects(rpc('control.acquire', { sessionId, takeover: true }, other), { code: 'control_busy' })
        await assert.rejects(rpc('control.release', { sessionId }), { code: 'control_busy' })
        await assert.rejects(rpc('settings.update', { config: { permission: { level: 'readonly' } } }), { code: 'configuration_busy' })
        await assert.rejects(switchBranch(), { code: 'turn_busy' })
      } finally { gate.resolve(); service.kernel = originalKernel }
      assert.equal((await transition).approval, 'readonly')
      assert.equal(service.sessionTransitions.size, 0)
      assert.equal((await rpc('sessions.get', { sessionId })).modeId, 'plan')
      assert.equal(await git('branch', '--show-current'), 'main')
    })

    await t.test('accepted slash command pins control and blocks branch changes while its kernel lookup is pending', async () => {
      const entered = deferred(), gate = deferred()
      service.kernel = async (...args) => { entered.resolve(); await gate.promise; return originalKernel(...args) }
      const command = rpc('commands.run', { sessionId, command: '/mode agent' })
      try {
        await entered.promise
        await assert.rejects(rpc('commands.run', { sessionId, command: '/mode yolo' }), { code: 'turn_busy' })
        await assert.rejects(rpc('turns.start', { sessionId, prompt: 'must not overlap' }), { code: 'session_busy' })
        await assert.rejects(rpc('control.acquire', { sessionId, takeover: true }, other), { code: 'control_busy' })
        await assert.rejects(rpc('settings.update', { config: { permission: { level: 'readonly' } } }), { code: 'configuration_busy' })
        await assert.rejects(switchBranch(), { code: 'turn_busy' })
      } finally { gate.resolve(); service.kernel = originalKernel }
      assert.equal((await command).state.modeId, 'agent')
      assert.equal(service.commandSessions.size, 0)
      assert.equal(await git('branch', '--show-current'), 'main')
    })

    await t.test('failed transition releases its reservation and does not persist an invalid provider', async () => {
      await assert.rejects(rpc('sessions.configure', { sessionId, provider: '__proto__' }), { code: 'unknown_provider' })
      assert.equal(service.sessionTransitions.size, 0)
      assert.equal((await rpc('sessions.get', { sessionId })).providerType, 'fixture')
      await rpc('sessions.configure', { sessionId, approval: 'manual' })
    })

    await t.test('asynchronous background activity rejects branch mutations without changing Git state', async () => {
      service.kernels.set(cwd, Promise.resolve({ ...kernel, background: { list: async () => [{ id: 'background', status: 'running' }] } }))
      try { await assert.rejects(switchBranch(), { code: 'turn_busy' }) }
      finally { service.kernels.set(cwd, Promise.resolve(kernel)) }
      assert.equal(await git('branch', '--show-current'), 'main')
      assert.equal(service.workspaceMutation, false)
    })

    await t.test('accepted branch operation excludes new turns, commands, transitions and foreign takeover', async () => {
      const entered = deferred(), gate = deferred()
      service.kernels.set(cwd, Promise.resolve({ ...kernel, background: { list: async () => { entered.resolve(); await gate.promise; return [] } } }))
      const switching = switchBranch()
      try {
        await entered.promise
        await assert.rejects(rpc('turns.start', { sessionId, prompt: 'must not run' }), { code: 'configuration_busy' })
        await assert.rejects(rpc('commands.run', { sessionId, command: '/mode yolo' }), { code: 'turn_busy' })
        await assert.rejects(rpc('sessions.configure', { sessionId, mode: 'yolo' }), { code: 'workspace_busy' })
        await assert.rejects(rpc('control.acquire', { sessionId, takeover: true }, other), { code: 'control_busy' })
      } finally { gate.resolve(); service.kernels.set(cwd, Promise.resolve(kernel)) }
      assert.equal((await switching).current, 'other')
      assert.equal(service.workspaceMutation, false)
      await rpc('control.acquire', { sessionId, takeover: true }, other)
      assert.equal(service.leases.get(sessionId).client, other.client)
    })

    await t.test('integrated snapshots hydrate a live prefix and replay only the future suffix', async () => {
      const turnId = 'snapshot-turn'
      await service.record({ sessionId, turnId, type: 'turn.start', payload: { prompt: 'Live snapshot' } })
      await service.record({ sessionId, turnId, type: 'stream.text.delta', payload: { step: 1, text: 'prefix ' } })
      const state = await rpc('sessions.get', { sessionId })
      assert.ok(state.liveEvents.some(event => event.payload.text === 'prefix '))
      await service.record({ sessionId, turnId, type: 'stream.text.delta', payload: { step: 1, text: 'suffix' } })
      const replay = await rpc('events.list', { sessionId, after: state.eventCursor })
      const rows = buildTranscript(state, [...state.liveEvents, ...replay.events])
      assert.deepEqual(rows.filter(row => row.type === 'assistant').map(row => row.text), ['prefix suffix'])
    })
  } finally {
    service.kernel = originalKernel
    await service.close()
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(directory, { recursive: true, force: true })
  }
})
