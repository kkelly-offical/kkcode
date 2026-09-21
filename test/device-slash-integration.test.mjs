import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createKernel } from '../src/kernel/index.mjs'
import { DeviceService } from '../src/device/service.mjs'

test('actual DeviceService executes the safe slash command surface without terminal-only prompts', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kkcode-slash-integration-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(directory, 'state')
  const provider = { type: 'openai', base_url: 'http://127.0.0.1:9/v1', default_model: 'fixture-model', models: ['fixture-model'], stream: false, discovery: { enabled: false } }
  await mkdir(process.env.KKCODE_HOME)
  await writeFile(path.join(process.env.KKCODE_HOME, 'config.yaml'), JSON.stringify({ provider: { default: 'fixture', fixture: provider }, mcp: { auto_discover: false }, skills: { auto_seed: false } }))
  const service = await new DeviceService({ cwd: directory, roots: [directory], createKernelImpl: async options => {
    const kernel = await createKernel({ ...options, trust: true })
    const config = kernel.configState.config
    config.provider.default = 'fixture'; config.provider.fixture = provider
    config.skills.auto_seed = false; config.mcp.auto_discover = false
    config.tool.sources = { builtin: true, local: false, plugin: false, mcp: false }
    kernel.providers.registerProvider('fixture', { async request() { return { text: 'fixture side answer', toolCalls: [], usage: {} } }, async *requestStream() { yield { type: 'text', content: 'fixture side answer' } } })
    return kernel
  } }).initialize()
  const rpc = (method, params = {}) => service.request({ id: randomUUID(), method, params })
  try {
    const session = await rpc('sessions.create', { cwd: directory })
    const sessionId = session.id
    await rpc('control.acquire', { sessionId })
    const run = command => rpc('commands.run', { sessionId, command })
    const catalog = await rpc('commands.list', { sessionId })
    assert.ok(catalog.some(entry => entry.name === 'mcp')); assert.ok(catalog.some(entry => entry.name === 'rewind'))
    for (const command of ['/help', '/status', '/session', '/commands', '/skills', '/agents', '/mcp', '/mcp reload', '/tasks', '/board', '/permission list', '/compact', '/undo', '/reload']) {
      const result = await run(command)
      assert.ok(result.panels?.length || result.output?.length, `${command} should return visible output`)
      assert.ok(!result.output?.some(entry => /TypeError|ReferenceError/.test(entry.text)), command)
    }
    assert.equal((await run('/history')).clientAction, 'sessions')
    assert.equal((await run('/rewind')).clientAction, 'session')
    assert.equal((await run('/model')).clientAction, 'models')
    assert.equal((await run('/provider edit fixture')).clientAction, 'provider')
    assert.equal((await run('/tasks stop nonexistent')).output[0].tone, 'error')
    assert.equal((await run('/btw fixture side question')).panels[0].text, 'fixture side answer')
    assert.equal((await rpc('sessions.get', { sessionId })).messages.length, 0, 'btw must not change the transcript')
    await run('/untrust'); assert.equal((await service.kernel(directory)).trustState.trusted, false)
    await run('/trust'); assert.equal((await service.kernel(directory)).trustState.trusted, true)
    await run('/permission yolo'); await run('/model fixture-new')
    assert.equal((await rpc('sessions.get', { sessionId })).approval, 'yolo')
    const created = await run('/new')
    const snapshot = await rpc('sessions.get', { sessionId: created.sessionId })
    assert.equal(snapshot.model, 'fixture-new'); assert.equal(snapshot.approval, 'yolo')
    assert.equal(service.leases.has(created.sessionId), false, 'new-session setup must release its temporary lease')
    const profile = await rpc('profile.update', { profile: { languages: ['English'], beginner: false } })
    assert.deepEqual((await rpc('profile.get')).languages, profile.languages)
  } finally {
    await service.close()
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(directory, { recursive: true, force: true })
  }
})
