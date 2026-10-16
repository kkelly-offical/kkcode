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

test('ACP form rejects sensitive metadata before contacting the client', async () => {
  const questions = [
    { id: 'password', text: 'Value' },
    { id: 'value', text: 'Password' },
    { id: 'value', text: 'Value', header: 'Password' },
    { id: 'value', text: 'Value', description: 'Paste the token' },
    { id: 'value', text: 'Value', description: '请填写令牌' },
    { id: 'value', text: 'Value', secret: true }
  ]
  for (const question of questions) {
    let seen = 0
    const answer = await requestAcpQuestion({
      capabilities: { elicitation: { form: {} } }, sessionId: 's', request: { questions: [question] },
      client: { request: async () => { seen++; return { action: 'accept', content: { q0: 'value' } } } }
    })
    assert.deepEqual(answer, { cancelled: true }, JSON.stringify(question))
    assert.equal(seen, 0, JSON.stringify(question))
  }
})

test('ACP form rejects secret and credential metadata before contacting the client', async t => {
  const questions = ['Secret', 'userSecret', 'credential', '凭据'].flatMap(value => [
    { id: value, text: 'Value' },
    { id: 'value', text: value },
    { id: 'value', text: 'Value', header: value },
    { id: 'value', text: 'Value', description: value }
  ])
  for (const question of questions) await t.test(JSON.stringify(question), async () => {
    let seen = 0
    const answer = await requestAcpQuestion({
      capabilities: { elicitation: { form: {} } }, sessionId: 's', request: { questions: [question] },
      client: { request: async () => { seen++; return { action: 'accept', content: { q0: 'value' } } } }
    })
    assert.deepEqual(answer, { cancelled: true })
    assert.equal(seen, 0)
  })
})

test('ACP form allows ordinary words resembling sensitive metadata', async t => {
  const questions = [
    { id: 'secretary', text: 'Value' },
    { id: 'value', text: 'Secretary' },
    { id: 'value', text: 'Value', header: 'Secretariat' },
    { id: 'value', text: 'Value', description: 'Administrative secretary' }
  ]
  for (const question of questions) await t.test(JSON.stringify(question), async () => {
    let seen = 0
    const answer = await requestAcpQuestion({
      capabilities: { elicitation: { form: {} } }, sessionId: 's', request: { questions: [question] },
      client: { request: async () => { seen++; return { action: 'accept', content: { q0: 'value' } } } }
    })
    assert.deepEqual(answer, { [question.id]: 'value' })
    assert.equal(seen, 1)
  })
})

test('ACP form round-trips multi-select arrays and rejects invalid answers', async () => {
  const question = { id: 'scopes', text: '范围', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }], multi: true, allowCustom: false }
  const run = async content => {
    let params
    const answer = await requestAcpQuestion({
      capabilities: { elicitation: { form: {} } }, sessionId: 's', request: { questions: [question] },
      client: { request: async (method, value) => { params = value; return { action: 'accept', content: { q0: content } } } }
    })
    return { answer, params }
  }
  const valid = await run(['a', 'b'])
  assert.deepEqual(valid.answer, { scopes: ['a', 'b'] })
  assert.equal(valid.params.requestedSchema.properties.q0.type, 'array')
  assert.deepEqual(valid.params.requestedSchema.properties.q0.items, { type: 'string', enum: ['a', 'b'] })
  for (const content of ['a', 'not-advertised', ['a', 'not-advertised']]) assert.deepEqual((await run(content)).answer, { cancelled: true })
})

test('ACP form keeps ordinary and custom answers compatible', async () => {
  const cases = [
    [{ id: 'value', text: 'Value', header: 'Details', description: 'Ordinary project metadata', secret: false }, 'ordinary', { value: 'ordinary' }],
    [{ id: 'value', text: 'Value', options: [{ label: 'small' }] }, 'custom', { value: 'custom' }],
    [{ id: 'values', text: 'Values', options: [{ label: 'a' }], multi: true }, ['a', 'custom'], { values: ['a', 'custom'] }]
  ]
  for (const [question, content, expected] of cases) {
    const answer = await requestAcpQuestion({
      capabilities: { elicitation: { form: {} } }, sessionId: 's', request: { questions: [question] },
      client: { request: async () => ({ action: 'accept', content: { q0: content } }) }
    })
    assert.deepEqual(answer, expected)
  }
})
