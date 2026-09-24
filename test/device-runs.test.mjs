import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import WebSocket from 'ws'
import { DeviceService } from '../src/device/service.mjs'
import { createDeviceServer } from '../src/device/server.mjs'
import { openRunStore } from '../src/storage/run-store.mjs'
import { ArtifactStore } from '../src/storage/artifact-store.mjs'
import { touchSession, flushNow } from '../src/kernel/session/store.mjs'
import { currentArtifactAccountId } from '../src/kernel/tool/artifacts.mjs'
import { createGateway } from '../src/remote/gateway.mjs'
import { identityHash } from '../src/remote/identity.mjs'
import { MemoryStore } from '../src/remote/store.mjs'
import { budgetProfileId } from '../src/storage/run-budget-profile.mjs'
import { localFreePolicyId } from '../src/storage/local-free-policy.mjs'

const local = { id: 'local', client: 'local' }
const contract = { objective: 'Public task objective', requiredCriteria: [{ id: 'check', description: 'Required acceptance check' }] }
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-device-runs-'))
  const previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  const cwd = path.join(root, 'workspace'); await mkdir(cwd)
  const service = await new DeviceService({ cwd, roots: [cwd] }).initialize()
  await service.bindOwner('owner', { organization: 'QA' })
  service.metadata.ownerGateway = 'http://localhost'; await service.saveIdentity()
  const sessionId = 'task-session'
  await touchSession({ sessionId, cwd, model: 'fixture', providerType: 'fixture', mode: 'agent' })
  await touchSession({ sessionId: 'other-session', cwd, model: 'fixture', providerType: 'fixture', mode: 'agent' })
  const accountId = await currentArtifactAccountId()
  const store = await openRunStore()
  const artifacts = new ArtifactStore()
  async function create(id, overrides = {}) {
    const binding = { accountId, projectId: 'fixture-project', cwd, sessionId, ...overrides }
    const actor = { accountId: binding.accountId, projectId: binding.projectId, sessionId: binding.sessionId, runId: id }
    const secret = await artifacts.put({ actor, content: 'INTERNAL-HOST-AUTHORIZATION-DO-NOT-SHARE', source: { kind: 'system' } })
    const input = await artifacts.put({ actor, content: 'PRIVATE-SERIALIZED-INPUT', source: { kind: 'user' } })
    const visible = await artifacts.put({ actor, content: 'PUBLIC-TOOL-OUTPUT\n'.repeat(50), mime: 'text/plain', source: { kind: 'tool', operationId: 'fixture-tool' } })
    const document = await artifacts.put({ actor, content: 'PUBLIC-DOCUMENT', mime: 'application/pdf', source: { kind: 'document' } })
    const run = await store.createRun({ id, ownerId: 'fixture-host', initialState: 'waiting_input', contract, binding: { ...binding, contractApprovalRef: secret.id } })
    return { run, actor, secret, input, visible, document }
  }
  const task = await create('run-visible')
  const request = (method, params = {}, principal = local) => service.request({ id: randomUUID(), method, params }, principal)
  const direct = (method, params = {}, principal = local) => service.runs.dispatch(method, params, principal)
  t.after(async () => {
    await service.close(); await store.close(); await flushNow()
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  })
  return { root, cwd, service, sessionId, accountId, task, store, artifacts, create, request, direct }
}

test('device task projection is session/account bound and does not expose host records or paths', async t => {
  const f = await fixture(t)
  await f.create('run-other-session', { sessionId: 'other-session' })
  await f.create('run-other-account', { accountId: 'another-account' })
  await f.create('run-other-workspace', { cwd: path.join(f.root, 'other-workspace') })
  const list = await f.direct('runs.list', { sessionId: f.sessionId })
  assert.deepEqual(list.items.map(item => item.id), [f.task.run.id])
  assert.equal(list.nextCursor, null)
  assert.equal(list.items[0].state, 'waiting_input')
  for (const forbidden of [f.root, f.accountId, 'fixture-host', f.task.secret.id, 'INTERNAL-HOST']) assert.equal(JSON.stringify(list).includes(forbidden), false)
  await assert.rejects(f.direct('runs.get', { sessionId: 'other-session', runId: f.task.run.id }), { code: 'run_missing' })
  await assert.rejects(f.direct('runs.get', { sessionId: f.sessionId, runId: 'run-other-account' }), { code: 'run_missing' })
  for (const extra of [{ accountId: 'another' }, { cwd: f.root }, { actor: {} }, { approval: { approved: true } }]) await assert.rejects(f.direct('runs.get', { sessionId: f.sessionId, runId: f.task.run.id, ...extra }), { code: 'run_invalid' })
  const events = await f.direct('runs.events', { sessionId: f.sessionId, runId: f.task.run.id })
  assert.ok(events.events.length)
  assert.equal(JSON.stringify(events).includes('binding'), false)
  assert.equal(JSON.stringify(events).includes(f.task.secret.id), false)
})

test('task pagination uses only visible account/session rows and supports cursor continuation', async t => {
  const f = await fixture(t)
  await f.create('run-second'); await f.create('run-third')
  const ids = []; let cursor
  do {
    const page = await f.direct('runs.list', { sessionId: f.sessionId, limit: 1, cursor })
    ids.push(...page.items.map(item => item.id)); cursor = page.nextCursor
    if (cursor) await assert.rejects(f.direct('runs.list', { sessionId: 'other-session', cursor }), { code: 'run_invalid_cursor' })
  } while (cursor)
  assert.equal(ids.length, 3)
  assert.equal(new Set(ids).size, 3)
  await assert.rejects(f.direct('runs.list', { sessionId: f.sessionId, cursor: Buffer.from('null').toString('base64url') }), { code: 'run_invalid_cursor' })
})

test('remote task budget is a bounded accounting projection, not a request or credential disclosure', async t => {
  const f = await fixture(t)
  let run = f.task.run
  const guard = () => ({ runId: run.id, expectedRevision: run.revision, ownerId: run.ownerId, ownerEpoch: run.ownerEpoch })
  await f.store.configureRunBudget({ ...guard(), budgetUsd: 3, deadlineAt: Date.now() + 60000,
    approval: { approved: true, actorId: 'private-budget-actor', reason: 'Host approved finite budget' } })
  run = await f.store.getRun(run.id)
  await f.store.reserveModelBudget({ ...guard(), requestId: 'private-request', amountUsd: 2, provider: 'private-provider', model: 'private-model', kind: 'delegation' })
  run = await f.store.getRun(run.id)
  await f.store.settleModelBudget({ ...guard(), requestId: 'private-request', amountUsd: null, status: 'unknown' })
  const view = await f.direct('runs.get', { sessionId: f.sessionId, runId: run.id })
  assert.deepEqual(Object.keys(view.budget).sort(), ['budgetUsd', 'deadlineAt', 'hasUnknown', 'reservedUsd', 'spentUsd', 'unknownUsd'])
  assert.equal(view.budget.spentUsd, 0); assert.equal(view.budget.unknownUsd, 2); assert.equal(view.budget.hasUnknown, true)
  for (const secret of ['private-request', 'private-provider', 'private-model', 'private-budget-actor']) assert.equal(JSON.stringify(view).includes(secret), false)
})

test('remote local-free projection exposes quota counters but no listener, route or private approval metadata', async t => {
  const f = await fixture(t)
  let run = f.task.run
  const guard = () => ({ runId: run.id, expectedRevision: run.revision, ownerId: run.ownerId, ownerEpoch: run.ownerEpoch })
  const profile = { version: 1, provider: 'private-free-provider', model: 'private-free-model', protocol: 'openai', scopeHash: 'd'.repeat(64), contextLimit: 1000,
    maxTokens: 100, compaction: false, rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, source: 'manual' }
  const policy = { version: 1, provider: profile.provider, model: profile.model, protocol: profile.protocol, scopeHash: profile.scopeHash,
    baseUrl: 'http://127.0.0.1:19877/v1', maxRequests: 5, maxTokens: 10000,
    listener: { pid: 197973, uid: 1000, fd: 71, inode: '888999', startTimeTicks: '999888', executable: '/private/fixture/python' } }
  await f.store.configureRunBudget({ ...guard(), budgetUsd: 0, deadlineAt: Date.now() + 60000,
    profiles: [{ ...profile, id: budgetProfileId(profile) }], localFreePolicy: { ...policy, id: localFreePolicyId(policy) },
    approval: { approved: true, actorId: 'private-free-author', reason: 'Approved host-only fixture quota' } })
  run = await f.store.getRun(run.id)
  await f.store.reserveModelBudget({ ...guard(), requestId: 'private-free-request', amountUsd: 0, provider: profile.provider, model: profile.model, profileId: budgetProfileId(profile), tokenAllowance: 150 })
  run = await f.store.getRun(run.id)
  await f.store.settleModelBudget({ ...guard(), requestId: 'private-free-request', amountUsd: null, status: 'unknown' })
  const scope = { sessionId: f.sessionId, runId: run.id }, viewer = { id: 'owner', actorId: 'viewer', client: 'viewer' }
  const view = await f.direct('runs.get', scope, viewer), events = await f.direct('runs.events', scope, viewer)
  assert.deepEqual(view.budget.localFree, { maxRequests: 5, maxTokens: 10000, usedRequests: 1, reservedTokens: 150 })
  assert.equal(view.budget.unknownUsd, 0); assert.equal(view.budget.hasUnknown, true)
  assert.deepEqual(Object.keys(view.budget).sort(), ['budgetUsd', 'deadlineAt', 'hasUnknown', 'localFree', 'reservedUsd', 'spentUsd', 'unknownUsd'])
  const serialized = JSON.stringify({ view, events })
  for (const secret of ['listener', 'scopeHash', 'baseUrl', 'localFreePolicy', 'private-free', '/private/fixture', policy.baseUrl, policy.scopeHash]) assert.equal(serialized.includes(secret), false, secret)
})

test('shared task evidence exposes only tool/document products, not authorizations or private acceptance', async t => {
  const f = await fixture(t)
  const viewer = { id: 'owner', actorId: 'viewer', client: 'viewer' }
  const scope = { sessionId: f.sessionId, runId: f.task.run.id }
  const page = await f.direct('runs.artifacts.list', scope, viewer)
  assert.deepEqual(new Set(page.items.map(item => item.id)), new Set([f.task.visible.id, f.task.document.id]))
  for (const id of [f.task.secret.id, f.task.input.id]) await assert.rejects(f.direct('runs.artifacts.read', { ...scope, id }, viewer), { code: 'run_artifact_unavailable' })
  const pieces = []; let cursor
  do {
    const page = await f.direct('runs.artifacts.download', { ...scope, id: f.task.visible.id, limit: 71, cursor }, viewer)
    pieces.push(Buffer.from(page.data, 'base64')); cursor = page.nextCursor
  } while (cursor)
  assert.equal(Buffer.concat(pieces).toString(), 'PUBLIC-TOOL-OUTPUT\n'.repeat(50))
  assert.match((await f.direct('runs.artifacts.download', { ...scope, id: f.task.document.id }, viewer)).filename, /\.pdf$/)
})

test('only actual owner can send version-fenced pause/cancel; task writes retain evidence', async t => {
  const f = await fixture(t)
  const viewer = { id: 'owner', actorId: 'viewer', client: 'viewer' }
  const params = { sessionId: f.sessionId, runId: f.task.run.id, expectedRevision: f.task.run.revision, expectedOwnerEpoch: f.task.run.ownerEpoch, confirmed: true }
  await assert.rejects(f.direct('runs.pause', params, viewer), { code: 'forbidden' })
  await assert.rejects(f.direct('runs.pause', { ...params, confirmed: false }), { code: 'confirmation_required' })
  await assert.rejects(f.direct('runs.pause', { ...params, expectedRevision: params.expectedRevision + 1 }), { code: 'run_changed' })
  const paused = await f.direct('runs.pause', params)
  assert.equal(paused.state, 'paused')
  assert.equal(paused.ownerEpoch, params.expectedOwnerEpoch)
  const cancelled = await f.direct('runs.cancel', { ...params, expectedRevision: paused.revision })
  assert.equal(cancelled.state, 'cancelled')
  assert.ok((await f.store.events({ runId: f.task.run.id })).filter(event => event.type === 'control.requested').length === 2)
  assert.equal((await f.artifacts.getMetadata({ actor: f.task.actor, id: f.task.visible.id })).id, f.task.visible.id)
})

test('device account changes during a task evidence read stop the response', async t => {
  const f = await fixture(t)
  const original = f.service.runs.artifacts.read.bind(f.service.runs.artifacts)
  f.service.runs.artifacts.read = async input => {
    const result = await original(input)
    f.service.metadata.owner = 'new-owner'; await f.service.saveIdentity()
    return result
  }
  await assert.rejects(f.direct('runs.artifacts.read', { sessionId: f.sessionId, runId: f.task.run.id, id: f.task.visible.id }), { code: 'run_scope_changed' })
})

test('actual HTTP task RPC needs login and cannot read after logout', async t => {
  const f = await fixture(t)
  const server = await createDeviceServer({ service: f.service, closeService: false, port: 0, bootstrapToken: 'runs-fixture-login' })
  t.after(() => server.close())
  const { address } = await server.listen()
  const post = (route, data, token) => fetch(address + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) })
  const rpc = () => ({ id: randomUUID(), method: 'runs.get', params: { sessionId: f.sessionId, runId: f.task.run.id } })
  assert.equal((await post('/api/v1/rpc', rpc())).status, 401)
  const login = await post('/api/v1/auth/pair', { bootstrap: 'runs-fixture-login', native: true })
  const token = (await login.json()).token
  const response = await post('/api/v1/rpc', rpc(), token)
  assert.equal(response.status, 200, await response.text())
  await post('/api/v1/auth/logout', {}, token)
  assert.equal((await post('/api/v1/rpc', rpc(), token)).status, 401)
})

test('actual relay shares exact task session reads, denies control and rechecks in-flight revocation', { timeout: 20_000 }, async t => {
  const f = await fixture(t), store = new MemoryStore()
  const owner = { id: 'owner', organization: 'QA' }, viewer = { id: 'viewer', organization: 'QA' }
  for (const account of [owner, viewer]) await store.put(`account:${account.id}`, account)
  for (const [id, kind, account] of [['browser', 'client', owner], ['device', 'device', owner], ['viewer', 'client', viewer]]) {
    await store.put(`identity-session:${id}`, { id, kind, accountId: account.id, deviceId: kind === 'device' ? f.service.metadata.id : null, expires: Date.now() + 60000 })
    await store.put(`token:${identityHash(id)}`, { sessionId: id, kind, account, expires: Date.now() + 60000 })
  }
  await store.put(`device:${f.service.metadata.id}`, { id: f.service.metadata.id, name: 'Task fixture', owner: 'owner', organization: 'QA', shares: { viewer: { [f.sessionId]: 'control' } } })
  const app = await createGateway({ origin: 'http://localhost', issuer: 'https://idp.invalid', oidcConfig: {}, store, dev: true, organization: 'QA' })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const socket = new WebSocket(address.replace('http:', 'ws:') + '/relay/device', { headers: { Host: 'localhost', Authorization: 'Bearer device' } })
  t.after(async () => { socket.terminate(); await app.close() })
  await once(socket, 'open')
  const registration = once(socket, 'message'); socket.send(JSON.stringify({ type: 'register', device: f.service.metadata })); await registration
  let entering, release
  const entered = new Promise(resolve => { entering = resolve }), resumed = new Promise(resolve => { release = resolve })
  socket.on('message', async raw => {
    const message = JSON.parse(raw)
    if (message.type !== 'request') return
    try {
      const result = await f.service.request(message.request, message.principal)
      if (message.request.id === 'revoked-task') { entering(); await resumed }
      socket.send(JSON.stringify({ type: 'response', id: message.id, result }))
    } catch (error) { socket.send(JSON.stringify({ type: 'response', id: message.id, error: { code: error.code, message: error.message }, status: error.status || 400 })) }
  })
  const rpc = (method, params = {}, id = randomUUID()) => app.inject({ method: 'POST', url: `/api/v1/devices/${f.service.metadata.id}/rpc`, headers: { host: 'localhost', authorization: 'Bearer viewer' }, payload: { id, method, params } })
  const params = { sessionId: f.sessionId, runId: f.task.run.id }
  const got = await rpc('runs.get', params)
  assert.equal(got.statusCode, 200, got.body)
  assert.equal(got.json().result.controls.canCancel, false)
  assert.equal((await rpc('runs.get', { ...params, sessionId: 'other-session' })).statusCode, 403)
  assert.equal((await rpc('runs.cancel', { ...params, expectedRevision: f.task.run.revision, expectedOwnerEpoch: 1, confirmed: true })).statusCode, 403)
  assert.equal((await rpc('runs.artifacts.read', { ...params, id: f.task.secret.id })).statusCode, 404)
  const waiting = rpc('runs.artifacts.read', { ...params, id: f.task.visible.id }, 'revoked-task')
  await entered
  const device = await store.get(`device:${f.service.metadata.id}`)
  await store.put(`device:${f.service.metadata.id}`, { ...device, shares: {} })
  release()
  const denied = await waiting
  assert.equal(denied.statusCode, 403)
  assert.equal(denied.json().result, undefined)
  assert.equal(JSON.stringify([...store.data]).includes('PUBLIC-TOOL-OUTPUT'), false)
})
