// Stable 1.0.4 regression cases from the remote-client feedback round.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createServer } from 'node:http'
import { createDeviceServer } from '../src/device/server.mjs'
import { DeviceService } from '../src/device/service.mjs'
import { ProtocolError } from '../src/protocol/index.mjs'
import { DeviceClient } from '../src/sdk/client.mjs'
import { appendMessage, appendPart, getSession } from '../src/kernel/session/store.mjs'
import { discoverDeviceModels } from '../src/device/model-settings.mjs'
import { groupSessions } from '../apps/web/src/sessions.mjs'
import { browserLink } from '../apps/web/src/source-links.mjs'
import { remoteErrorMessage } from '../apps/web/src/errors.mjs'
import { collapseCompletedRuns } from '../apps/web/src/conversation-presentation.mjs'
import { buildTranscript } from '../apps/web/src/transcript.mjs'

test('direct SSH HTTP routes use the custom error envelope and never leak unexpected exception messages', async t => {
  const service = new EventEmitter()
  service.close = async () => {}
  service.request = async body => { if(body.method === 'models.discover') throw new Error('fixture-private-diagnostic'); throw new ProtocolError('unknown_provider', '当前电脑没有这个渠道', 422) }
  const server = await createDeviceServer({ service, port: 0, bootstrapToken: 'fixture-preview1' })
  t.after(() => server.close())
  const { address } = await server.listen()
  const pairing = await fetch(address + '/api/v1/auth/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap: 'fixture-preview1', native: true }) }).then(r => r.json())
  const sdk = new DeviceClient({ url: address, token: pairing.token, retries: 0 })
  await assert.rejects(sdk.request('sessions.configure'), error => error.code === 'unknown_provider' && error.status === 422 && error.message === '当前电脑没有这个渠道')
  await assert.rejects(sdk.request('models.discover'), error => error.code === 'internal_error' && error.status === 500 && !error.message.includes('fixture-private') && error.message.includes('kkcode doctor'))
})

test('SDK reads old Fastify flat errors instead of discarding the real reason', async () => {
  const sdk = new DeviceClient({ url: 'https://fixture.invalid', retries: 0, fetch: async () => new Response(JSON.stringify({ statusCode: 400, code: 'unknown_provider', error: 'Bad Request', message: 'Configure this provider before selecting it' }), { status: 400 }) })
  await assert.rejects(sdk.request('sessions.configure'), error => error.code === 'unknown_provider' && error.message.startsWith('Configure') && remoteErrorMessage(error).includes('当前电脑'))
})

test('empty-session metadata is non-destructive, and invalid initial selection creates no orphan', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-preview1-session-')), cwd = path.join(root, 'work')
  await mkdir(cwd)
  const old = process.env.KKCODE_HOME; process.env.KKCODE_HOME = path.join(root, 'private')
  const service = await new DeviceService({ cwd, roots: [cwd] }).initialize()
  t.after(async () => { await service.close(); if(old === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = old; await rm(root, { recursive: true, force: true }) })
  const owner = { id: 'local', client: 'fixture' }
  await assert.rejects(service.dispatch('sessions.create', { cwd, provider: 'not-on-this-computer' }, owner), { code: 'unknown_provider' })
  assert.equal((await service.dispatch('sessions.list', {}, owner)).length, 0)
  const created = await service.dispatch('sessions.create', { cwd, mode: 'auto' }, owner)
  assert.equal(created.modeId, 'auto')
  const empty = (await service.dispatch('sessions.list', {}, owner))[0]
  assert.equal(empty.hasContent, false); assert.equal(groupSessions([empty]).length, 0)
  assert.ok(await getSession(created.id), 'hiding a draft must not delete it')
  service.turns.set(created.id, {})
  assert.equal(groupSessions(await service.dispatch('sessions.list', {}, owner)).length, 1, 'an active empty turn remains visible')
  service.turns.delete(created.id)
  await appendMessage(created.id, 'user', 'hello')
  assert.equal((await service.dispatch('sessions.list', {}, owner))[0].hasContent, true)
  const tools = await service.dispatch('sessions.create', { cwd }, owner)
  await appendPart(tools.id, { type: 'tool-call', tool: 'read', status: 'completed' })
  assert.equal((await service.dispatch('sessions.list', {}, owner)).find(row => row.id === tools.id).hasContent, true)
  assert.equal(groupSessions([{ id: 'old-host', title: 'Older history' }]).length, 1, 'unknown legacy metadata is never treated as empty')
})

test('model discovery distinguishes missing channel, authentication, bad endpoint and unreachable model host', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-preview1-models-')), old = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = root
  t.after(async () => { if(old === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = old; await rm(root, { recursive: true, force: true }) })
  await assert.rejects(discoverDeviceModels({ cwd: root }, { provider: 'unconfigured-fixture' }), error => error.code === 'unknown_provider' && error.status === 422)
  const server = createServer((req, res) => {
    if(req.url === '/local/v1/models') { assert.equal(req.headers.authorization, undefined); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'local-responses-model' }] })); return }
    res.statusCode = req.url.startsWith('/auth/') ? 401 : 404; res.end('fixture response, not a model list')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  for(const [prefix, code] of [['auth', 'provider_auth'], ['absent', 'model_catalog_invalid']]) {
    await assert.rejects(discoverDeviceModels({ cwd: root }, { connection: { base_url: `http://127.0.0.1:${port}/${prefix}`, api_key: '', api_key_env: '' } }), error => error.code === code && /[\u4e00-\u9fff]/u.test(error.message))
  }
  const oldOpenAI = process.env.OPENAI_API_KEY
  try {
    process.env.OPENAI_API_KEY = 'fixture-ambient-key-never-forwarded'
    const catalog = await discoverDeviceModels({ cwd: root }, { connection: { type: 'openai-responses', base_url: `http://127.0.0.1:${port}/local/v1/responses`, api_key: '' } })
    assert.equal(catalog.models[0].id, 'local-responses-model'); assert.equal(catalog.protocol, 'responses')
  } finally { if(oldOpenAI === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAI }
  await new Promise(resolve => server.close(resolve))
  await assert.rejects(discoverDeviceModels({ cwd: root }, { connection: { base_url: `http://127.0.0.1:${port}/v1`, api_key: '', api_key_env: '' } }), error => error.code === 'provider_unreachable' && error.message.includes('localhost'))
})

test('finished runs fold intermediate text/tools/thinking but retain the final answer and original data', () => {
  const rows = [{ id: 'u', type: 'user', timestamp: 1000, text: 'question' }, { id: 't', type: 'thinking', timestamp: 1100, text: 'reasoning' }, { id: 'c', type: 'assistant', timestamp: 2000, text: 'checking' }, { id: 'tool', type: 'tool', timestamp: 3000, payload: {} }, { id: 'final', type: 'assistant', timestamp: 6000, text: 'final report' }]
  const before = structuredClone(rows)
  assert.deepEqual(collapseCompletedRuns(rows, true), rows)
  const folded = collapseCompletedRuns(rows)
  assert.deepEqual(folded.map(row => row.type), ['user', 'run-summary', 'assistant'])
  assert.equal(folded[1].durationMs, 5000); assert.equal(folded[1].tools, 1)
  assert.deepEqual(folded[1].rows.map(row => row.id), ['t', 'c', 'tool']); assert.equal(folded[2].text, 'final report')
  assert.deepEqual(rows, before)
  assert.deepEqual(collapseCompletedRuns([...rows, { id: 'failure', type: 'error', text: 'failed' }]), [...rows, { id: 'failure', type: 'error', text: 'failed' }])
  assert.deepEqual(collapseCompletedRuns(rows.slice(0, 2)), rows.slice(0, 2))
})

test('live thinking retains identity and the finished transcript measures the complete turn', () => {
  const events = [
    { id: 'u', type: 'turn.start', turnId: 'turn', timestamp: 1000, payload: { prompt: 'question' } },
    { id: 't', type: 'stream.thinking.start', turnId: 'turn', timestamp: 1100, payload: { step: 1 } },
    { id: 't1', type: 'stream.thinking.delta', turnId: 'turn', timestamp: 1200, payload: { step: 1, text: 'first ' } },
    { id: 't2', type: 'stream.thinking.delta', turnId: 'turn', timestamp: 1500, payload: { step: 1, text: 'second' } },
    { id: 'a', type: 'stream.text.delta', turnId: 'turn', timestamp: 2000, payload: { step: 1, text: 'answer' } },
    { id: 'done', type: 'turn.finish', turnId: 'turn', timestamp: 4000, payload: { reply: 'answer' } },
  ]
  assert.equal(buildTranscript({}, events.slice(0, 3))[1].id, buildTranscript({}, events.slice(0, 4))[1].id)
  assert.equal(buildTranscript({}, events.slice(0, 4))[1].text, 'first second')
  const folded = collapseCompletedRuns(buildTranscript({}, events))
  assert.equal(folded[1].durationMs, 3000)
})

test('source links allow only explicit HTTP(S) browsing and errors hide credentials', () => {
  assert.equal(browserLink('https://example.org/source#section'), 'https://example.org/source#section')
  for(const input of ['javascript:alert(1)', 'file:///etc/passwd', 'intent://launch', '//evil.example', 'https://user:pass@example.org/', '/local/file']) assert.equal(browserLink(input), null)
  const text = remoteErrorMessage({ status: 400, message: 'request api_key=fixture-private-value Bearer fixture-secret-value' })
  assert.ok(text.includes('操作未完成')); assert.ok(!text.includes('fixture-private-value')); assert.ok(!text.includes('fixture-secret-value'))
})
