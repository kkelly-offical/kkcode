import test from 'node:test'
import assert from 'node:assert/strict'
import * as acp from '@agentclientprotocol/sdk'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createAcpApp } from '../src/acp/server.mjs'
import { createKernel } from '../src/kernel/index.mjs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

test('installed-style CLI ACP stdio has no terminal output and rejects untrusted editor MCP startup', { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-acp-stdio-'))
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/index.mjs', import.meta.url)), 'acp'], { cwd: root, env: { ...process.env, KKCODE_HOME: path.join(root, 'private'), KKCODE_DISABLE_UPDATE_CHECK: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume()
  const exited = once(child, 'exit')
  const client = acp.client({ name: 'stdio-fixture' }).connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))
  t.after(async () => { client.close(); if (child.exitCode === null) child.kill('SIGTERM'); await exited; await rm(root, { recursive: true, force: true }) })
  const initialized = await client.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })
  assert.equal(initialized.agentInfo.name, 'kkcode')
  await assert.rejects(client.agent.request('session/new', { cwd: root, mcpServers: [{ name: 'untrusted', command: process.execPath, args: ['--version'], env: [] }] }), error => error.code === -32602 && /Trust this workspace/.test(error.data?.message))
  await assert.rejects(client.agent.request('session/new', { cwd: '.', mcpServers: [] }), error => error.code === -32602 && /absolute/.test(error.data?.message))
  const created = await client.agent.request('session/new', { cwd: root, mcpServers: [] })
  assert.ok(created.sessionId)
  child.stdin.end()
  assert.equal((await exited)[0], 0)
})

test('official ACP client drives real kernel sessions, mode changes, tool approvals, cancellation and reload', { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-acp-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'private')
  let started, pendingStarted = new Promise(resolve => { started = resolve })
  const createKernelImpl = async options => {
    const kernel = await createKernel({ ...options, trustState: { trusted: true } })
    const config = kernel.configState.config
    config.provider = { default: 'fixture', fixture: { default_model: 'test', stream: false, retry_attempts: 0 } }
    config.session.title_generation = false; config.skills.auto_seed = false; config.mcp.auto_discover = false
    config.agent.verify_completion = false; config.agent.max_steps = 4
    config.git_auto = { enabled: false }; config.tool.sources = { builtin: true, mcp: false, plugin: false, local: false }
    let writes = 0
    kernel.providers.registerProvider('fixture', { async request(input) {
      const latest = input.messages.filter(message => message.role === 'user' && typeof message.content === 'string').at(-1)?.content
      if(latest === 'WAIT') { started(); await new Promise((_, reject) => { const abort = () => reject(new Error('Cancelled')); if(input.signal.aborted) abort(); else input.signal.addEventListener('abort', abort, { once: true }) }) }
      if(latest === 'WRITE' && writes++ === 0) return { text: '', toolCalls: [{ id: 'write', name: 'write', args: { path: 'result.txt', content: 'ACP works' } }], stopReason: 'tool_use', usage: {} }
      return { text: 'Done.', toolCalls: [], stopReason: 'end_turn', usage: { input: 10, output: 2 } }
    }, async *requestStream() { throw new Error('Fixture uses non-streaming requests') } })
    return kernel
  }
  const host = createAcpApp({ createKernelImpl }), events = []
  let permissions = 0
  const client = acp.client({ name: 'fixture' }).onNotification('session/update', ctx => { events.push(ctx.params.update) }).onRequest('session/request_permission', () => { permissions++; return { outcome: { outcome: 'selected', optionId: 'allow_once' } } })
  const connection = client.connect(host.app)
  t.after(async () => { connection.close(); await host.shutdown(); if(previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  const init = await connection.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })
  assert.equal(init.agentInfo.name, 'kkcode'); assert.equal(init.agentCapabilities.loadSession, true)
  const session = await connection.agent.request('session/new', { cwd: root, mcpServers: [] })
  assert.ok(session.modes.availableModes.some(mode => mode.id === 'auto'))
  const result = await connection.agent.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'WRITE' }] })
  assert.equal(result.stopReason, 'end_turn'); assert.equal(await readFile(path.join(root, 'result.txt'), 'utf8'), 'ACP works')
  assert.ok(permissions > 0); assert.ok(events.some(event => event.sessionUpdate === 'tool_call_update'))
  await connection.agent.request('session/set_mode', { sessionId: session.sessionId, modeId: 'plan' })
  const pending = connection.agent.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'WAIT' }] })
  await pendingStarted
  await connection.agent.notify('session/cancel', { sessionId: session.sessionId })
  assert.equal((await pending).stopReason, 'cancelled')
  connection.close(); await host.shutdown()
  const resumedHost = createAcpApp({ createKernelImpl }), resumed = client.connect(resumedHost.app)
  try {
    await resumed.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })
    const loaded = await resumed.agent.request('session/load', { sessionId: session.sessionId, cwd: root, mcpServers: [] })
    assert.equal(loaded.modes.currentModeId, 'plan')
    assert.ok(events.some(event => event.sessionUpdate === 'user_message_chunk'))
  } finally { resumed.close(); await resumedHost.shutdown() }
})
