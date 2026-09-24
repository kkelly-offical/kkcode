import test from 'node:test'
import assert from 'node:assert/strict'
import * as acp from '@agentclientprotocol/sdk'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createAcpApp } from '../src/acp/server.mjs'
import { requestAcpQuestion } from '../src/acp/elicitation.mjs'

test('official ACP client negotiates user forms, binds session and safely declines legacy capability', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'kk-acp-question-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const capability of [{ form: {} }, {}, { form: null }]) {
    let answer, seen = 0
    const updates = []
    const host = createAcpApp({ createKernelImpl: async options => ({
      configState: { config: { provider: { default: 'fixture', fixture: { default_model: 'fixture' } }, permission: {} } },
      trustState: { trusted: true }, turns: { newSessionId: () => 'acp-q' },
      sessions: { touchSession: async () => {} }, shutdown: async () => {},
      executeTurn: async () => { answer = await options.handlers.onQuestionPrompt({ questions: [{ id: 'choice', text: '选择实现范围', options: [{ label: '仅测试', value: 'tests' }], allowCustom: false }] }); return { reply: 'done' } }
    }) })
    const client = acp.client({ name: 'form-fixture' })
      .onNotification('session/update', ctx => updates.push(ctx.params.update))
      .onRequest('elicitation/create', ctx => { seen++; assert.equal(ctx.params.sessionId, 'acp-q'); assert.equal(ctx.params.mode, 'form'); return { action: 'accept', content: { q0: 'tests' } } })
    const connection = client.connect(host.app)
    try {
      await connection.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { elicitation: capability } })
      await connection.agent.request('session/new', { cwd: root, mcpServers: [] })
      await connection.agent.request('session/prompt', { sessionId: 'acp-q', prompt: [{ type: 'text', text: 'ask' }] })
      if (capability.form) { assert.equal(seen, 1); assert.deepEqual(answer, { choice: 'tests' }) }
      else { assert.equal(seen, 0); assert.deepEqual(answer, { cancelled: true }); assert.ok(updates.some(update => update.content?.text?.includes('未声明支持'))) }
    } finally { connection.close(); await host.shutdown() }
  }
})

test('ACP form validates accepted fields, refuses credential questions and does not treat decline as consent', async () => {
  const base = { capabilities: { elicitation: { form: {} } }, sessionId: 's', request: { questions: [{ id: 'a', text: '范围', options: [{ label: 'small' }], allowCustom: false }] } }
  for (const response of [{ action: 'decline', content: { q0: 'small' } }, { action: 'accept', content: { q0: 'not-advertised' } }, { action: 'accept', content: { q0: 'small', extra: 'no' } }]) assert.deepEqual(await requestAcpQuestion({ ...base, client: { request: async () => response } }), { cancelled: true })
  assert.deepEqual(await requestAcpQuestion({ ...base, request: { questions: [{ id: 'secret', text: 'API key' }] }, client: { request: () => { throw new Error('must not request') } } }), { cancelled: true })
})
