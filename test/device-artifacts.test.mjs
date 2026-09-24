import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { once } from 'node:events'
import WebSocket from 'ws'
import { DeviceService } from '../src/device/service.mjs'
import { DeviceArtifacts } from '../src/device/artifacts.mjs'
import { createDeviceServer } from '../src/device/server.mjs'
import { createConversationArtifactAccess, archiveToolText, trustedArtifactRef } from '../src/kernel/tool/artifacts.mjs'
import { touchSession, appendMessage, flushNow, getSession } from '../src/kernel/session/store.mjs'
import { beginToolOperation, resolveToolOperation } from '../src/kernel/tool/operation-journal.mjs'
import { createGateway } from '../src/remote/gateway.mjs'
import { identityHash } from '../src/remote/identity.mjs'
import { MemoryStore } from '../src/remote/store.mjs'

const local = { id: 'local', client: 'local' }
async function fixture(t, { bound = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-device-artifacts-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  const cwd = path.join(root, 'workspace'); await mkdir(cwd)
  const service = await new DeviceService({ cwd, roots: [cwd] }).initialize()
  if (bound) { await service.bindOwner('owner', { organization: 'QA' }); service.metadata.ownerGateway = 'http://localhost'; await service.saveIdentity() }
  let now = 1000
  const storeOptions = { clock: () => now, limits: { retentionMs: 100 } }
  service.artifacts = new DeviceArtifacts(service, { storeOptions })
  const sessionId = 'artifact-session'
  await touchSession({ sessionId, cwd, model: 'fixture', providerType: 'fixture', mode: 'agent' })
  const access = createConversationArtifactAccess({ sessionId, cwd, turnId: 'fixture', storeOptions })
  const content = `头部\n${'synthetic evidence line\n'.repeat(1000)}尾部\n`
  const archived = await archiveToolText({ output: content, access, callId: 'fixture', limit: 4000 })
  const ref = trustedArtifactRef(archived)
  assert.ok(ref)
  const request = (method, params = {}, principal = local) => service.request({ id: randomUUID(), method, params }, principal)
  t.after(async () => {
    await service.close(); await flushNow()
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  })
  return { root, cwd, service, sessionId, ref, access, content, request, advance: amount => { now += amount } }
}

test('device artifact reads/downloads are scoped and binary exact without paths or actor selectors', async t => {
  const f = await fixture(t)
  const list = await f.request('artifacts.list', { sessionId: f.sessionId })
  assert.equal(list.items[0].id, f.ref.id)
  assert.equal('scope' in list.items[0], false)
  assert.equal(JSON.stringify(list).includes(f.root), false)
  assert.ok((await f.request('status')).features.includes('artifacts.v1'))
  const pieces = []; let cursor
  do {
    const page = await f.request('artifacts.download', { sessionId: f.sessionId, id: f.ref.id, cursor, limit: 1703 })
    assert.equal(page.offset, pieces.reduce((sum, piece) => sum + piece.length, 0))
    assert.equal(page.encoding, 'base64'); assert.equal(page.mime, 'text/plain; charset=utf-8')
    assert.equal(page.sha256, f.ref.sha256)
    pieces.push(Buffer.from(page.data, 'base64')); cursor = page.nextCursor
  } while (cursor)
  const full = Buffer.concat(pieces)
  assert.equal(full.toString(), f.content)
  assert.equal(createHash('sha256').update(full).digest('hex'), f.ref.sha256)
  assert.equal((await f.request('artifacts.search', { sessionId: f.sessionId, id: f.ref.id, query: '尾部' })).matches.length, 1)
  await touchSession({ sessionId: 'other', cwd: f.cwd, model: 'fixture', providerType: 'fixture', mode: 'agent' })
  await assert.rejects(f.request('artifacts.read', { sessionId: 'other', id: f.ref.id }), { code: 'artifact_not_found' })
  for (const addition of [{ actor: {} }, { path: f.root }, { runId: 'other' }, { accountId: 'owner' }]) {
    await assert.rejects(f.request('artifacts.read', { sessionId: f.sessionId, id: f.ref.id, ...addition }), { code: 'artifact_invalid' })
  }
  await assert.rejects(f.request('artifacts.download', { sessionId: f.sessionId, id: f.ref.id, limit: 256 * 1024 + 1 }), { code: 'artifact_invalid' })
})

test('real local HTTP requires login on every download page and closes access after logout', async t => {
  const f = await fixture(t)
  const server = await createDeviceServer({ service: f.service, closeService: false, port: 0, bootstrapToken: 'artifact-fixture-login' })
  t.after(() => server.close())
  const { address } = await server.listen()
  const post = (route, data, token) => fetch(address + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) })
  const rpc = cursor => ({ id: randomUUID(), method: 'artifacts.download', params: { sessionId: f.sessionId, id: f.ref.id, limit: 64, cursor } })
  assert.equal((await post('/api/v1/rpc', rpc())).status, 401)
  const login = await post('/api/v1/auth/pair', { bootstrap: 'artifact-fixture-login', native: true })
  const token = (await login.json()).token
  const first = await post('/api/v1/rpc', rpc(), token)
  assert.equal(first.status, 200)
  const page = (await first.json()).result
  assert.ok(page.nextCursor)
  assert.equal((await post('/api/v1/auth/logout', {}, token)).status, 200)
  assert.equal((await post('/api/v1/rpc', rpc(page.nextCursor), token)).status, 401)
})

test('owner lifecycle preserves canonical references, running and unknown outcomes; deletion explicitly retires scope', async t => {
  const f = await fixture(t, { bound: true })
  const viewer = { id: 'owner', actorId: 'viewer', client: 'viewer' }
  assert.equal((await f.request('artifacts.list', { sessionId: f.sessionId }, viewer)).items.length, 1)
  await assert.rejects(f.request('artifacts.pin', { sessionId: f.sessionId, id: f.ref.id, pinned: true }, viewer), { code: 'forbidden' })
  await assert.rejects(f.request('artifacts.prune', { sessionId: f.sessionId, confirmed: true }, viewer), { code: 'forbidden' })
  await assert.rejects(f.request('artifacts.prune', { sessionId: f.sessionId }), { code: 'confirmation_required' })
  await appendMessage(f.sessionId, 'user', [{ type: 'tool_result', tool_use_id: 'fixture', content: 'archived output' }], { artifactRefs: [f.ref] })
  f.service.turns.set(f.sessionId, { client: 'test', controller: new AbortController() })
  await assert.rejects(f.request('artifacts.prune', { sessionId: f.sessionId, confirmed: true }), { code: 'artifact_busy' })
  f.service.turns.delete(f.sessionId)
  const operation = await beginToolOperation({ sessionId: f.sessionId, turnId: 'fixture', tool: 'external', args: {} })
  await operation.finish('uncertain')
  await assert.rejects(f.request('artifacts.prune', { sessionId: f.sessionId, confirmed: true }), { code: 'artifact_unresolved' })
  await assert.rejects(f.request('sessions.delete', { sessionId: f.sessionId, confirmed: true }), { code: 'artifact_unresolved' })
  await resolveToolOperation(f.sessionId, operation.id, true)
  assert.deepEqual((await f.request('artifacts.prune', { sessionId: f.sessionId, confirmed: true })).removed, [])
  f.advance(101)
  assert.deepEqual((await f.request('artifacts.prune', { sessionId: f.sessionId, confirmed: true })).removed, [], 'canonical references survive TTL')
  assert.equal((await f.request('artifacts.list', { sessionId: f.sessionId })).items[0].retention.referenced, true)
  await f.request('sessions.delete', { sessionId: f.sessionId, confirmed: true })
  assert.equal(await getSession(f.sessionId), null)
  assert.deepEqual((await f.request('artifacts.prune', { confirmed: true })).removed, [])
  f.advance(101)
  assert.deepEqual((await f.request('artifacts.prune', { confirmed: true })).removed, [f.ref.id])
})

test('retention reconciliation does not keep resetting TTL for unused conversation outputs', async t => {
  const f = await fixture(t)
  assert.deepEqual((await f.request('artifacts.prune', { sessionId: f.sessionId, confirmed: true })).removed, [])
  f.advance(101)
  assert.deepEqual((await f.request('artifacts.prune', { sessionId: f.sessionId, confirmed: true })).removed, [f.ref.id])
})

test('prune fences a new device turn before asynchronous task-state checks finish', async t => {
  const f = await fixture(t)
  await f.request('control.acquire', { sessionId: f.sessionId })
  let enter, release
  const entered = new Promise(resolve => { enter = resolve }), resumed = new Promise(resolve => { release = resolve })
  f.service.kernels.set('task-check-fixture', Promise.resolve({ background: { async list() { enter(); await resumed; return [] } }, async shutdown() {} }))
  const pruning = f.request('artifacts.prune', { sessionId: f.sessionId, confirmed: true })
  await entered
  try {
    await assert.rejects(f.request('turns.start', { sessionId: f.sessionId, prompt: 'Must not begin during prune' }), { code: 'session_busy' })
  } finally { release() }
  assert.deepEqual((await pruning).removed, [])
})

test('real relay shares only selected session artifact reads, rejects lifecycle writes and fences revocation in flight', { timeout: 15000 }, async t => {
  const f = await fixture(t, { bound: true }), store = new MemoryStore()
  const owner = { id: 'owner', organization: 'QA' }, viewer = { id: 'viewer', organization: 'QA' }
  for (const account of [owner, viewer]) await store.put(`account:${account.id}`, account)
  for (const [id, kind, account] of [['browser', 'client', owner], ['device', 'device', owner], ['viewer', 'client', viewer]]) {
    await store.put(`identity-session:${id}`, { id, kind, accountId: account.id, deviceId: kind === 'device' ? f.service.metadata.id : null, expires: Date.now() + 60000 })
    await store.put(`token:${identityHash(id)}`, { sessionId: id, kind, account, expires: Date.now() + 60000 })
  }
  await store.put(`device:${f.service.metadata.id}`, { id: f.service.metadata.id, name: 'Artifact fixture', owner: 'owner', organization: 'QA', shares: { viewer: { [f.sessionId]: 'view' } } })
  const app = await createGateway({ origin: 'http://localhost', issuer: 'https://idp.invalid', oidcConfig: {}, store, dev: true, organization: 'QA' })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const socket = new WebSocket(address.replace('http:', 'ws:') + '/relay/device', { headers: { Host: 'localhost', Authorization: 'Bearer device' } })
  t.after(async () => { socket.terminate(); await app.close() })
  await once(socket, 'open')
  const registered = once(socket, 'message')
  socket.send(JSON.stringify({ type: 'register', device: f.service.metadata }))
  await registered
  let entering, release
  const entered = new Promise(resolve => { entering = resolve }), resumed = new Promise(resolve => { release = resolve })
  socket.on('message', async raw => {
    const message = JSON.parse(raw)
    if (message.type !== 'request') return
    try {
      const result = await f.service.request(message.request, message.principal)
      if (message.request.id === 'revoked-page') { entering(); await resumed }
      socket.send(JSON.stringify({ type: 'response', id: message.id, result }))
    } catch (error) { socket.send(JSON.stringify({ type: 'response', id: message.id, error: { code: error.code, message: error.message }, status: error.status || 400 })) }
  })
  const rpc = (method, params = {}, id = randomUUID()) => app.inject({ method: 'POST', url: `/api/v1/devices/${f.service.metadata.id}/rpc`, headers: { host: 'localhost', authorization: 'Bearer viewer' }, payload: { id, method, params } })
  assert.deepEqual((await rpc('status')).json().result.features, ['artifacts.v1', 'runs.v1'])
  const downloaded = await rpc('artifacts.download', { sessionId: f.sessionId, id: f.ref.id, limit: 64 })
  assert.equal(downloaded.statusCode, 200, downloaded.body)
  assert.equal((await rpc('artifacts.read', { sessionId: 'unshared', id: f.ref.id })).statusCode, 403)
  for (const method of ['artifacts.pin', 'artifacts.prune']) assert.equal((await rpc(method, { sessionId: f.sessionId, id: f.ref.id, pinned: true, confirmed: true })).statusCode, 403)
  const waiting = rpc('artifacts.download', { sessionId: f.sessionId, id: f.ref.id }, 'revoked-page')
  await entered
  const device = await store.get(`device:${f.service.metadata.id}`)
  await store.put(`device:${f.service.metadata.id}`, { ...device, shares: {} })
  release()
  const denied = await waiting
  assert.equal(denied.statusCode, 403)
  assert.equal(denied.json().result, undefined)
  assert.equal(JSON.stringify([...store.data]).includes('synthetic evidence line'), false, 'relay does not persist payloads')
})
