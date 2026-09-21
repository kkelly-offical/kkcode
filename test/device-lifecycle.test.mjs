import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../src/remote/store.mjs'
import { writePrivateFile } from '../src/storage/private-file.mjs'
import { acquireProcessLock } from '../src/storage/process-lock.mjs'
import { acceptRemoteIdentity, acquireDeviceLifecycleLock, prepareRemoteBinding, readDeviceLifecycle, registerDeviceLifecycle, unbindLocalDevice } from '../src/remote/device-lifecycle.mjs'

const identity = () => ({ id: 'device-fixture', name: 'Fixture computer', owner: 'owner', ownerGateway: 'https://gateway.example', profile: { id: 'owner', organization: 'qa', name: 'Owner' } })
const credentials = () => ({ profile: identity().profile, gateway: 'https://gateway.example', access_token: 'fixture-access', refresh_token: 'fixture-refresh', expiresAt: Date.now() + 3600000 })
async function localFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-device-lifecycle-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writePrivateFile(path.join(root, 'device', 'identity.json'), JSON.stringify(identity()))
  await writePrivateFile(path.join(root, 'remote-credentials.json'), JSON.stringify(credentials()))
  await writePrivateFile(path.join(root, 'history-sentinel.json'), '{"preserved":true}')
  return root
}
async function gatewayFixture(t) {
  const app = Fastify(), store = new MemoryStore(), revoked = [], disconnected = [], audits = []
  const sessions = {
    bound: { account: { id: 'owner', organization: 'qa' }, session: { id: 'bound', deviceId: 'device-fixture' }, kind: 'device' },
    fresh: { account: { id: 'owner', organization: 'qa' }, session: { id: 'fresh', deviceId: null }, kind: 'device' },
    browser: { account: { id: 'owner', organization: 'qa' }, session: { id: 'browser', deviceId: null }, kind: 'client' },
    other: { account: { id: 'other', organization: 'qa', admin: true }, session: { id: 'other', deviceId: 'device-fixture' }, kind: 'device' },
    wrong: { account: { id: 'owner', organization: 'qa' }, session: { id: 'wrong', deviceId: 'other-device' }, kind: 'device' },
  }
  for (const value of Object.values(sessions)) await store.put(`identity-session:${value.session.id}`, value.session)
  await store.put('device:device-fixture', { id: 'device-fixture', owner: 'owner', organization: 'qa', shares: { colleague: { session1: 'control' } } })
  const authenticate = async (req, kind) => {
    const entry = sessions[req.headers.authorization?.replace('Bearer ', '')]
    if (!entry || entry.kind !== kind || !await store.get(`identity-session:${entry.session.id}`)) throw Object.assign(new Error('Login required'), { statusCode: 401 })
    return entry
  }
  registerDeviceLifecycle({ app, store, authenticate, audit: (...args) => { audits.push(args) }, revoke: async id => { revoked.push(id); await store.delete(`identity-session:${id}`) }, onUnbind: id => { disconnected.push(id) } })
  t.after(() => app.close())
  const unbind = (token = 'bound', confirmation = 'device-fixture') => app.inject({ method: 'POST', url: '/api/v1/devices/device-fixture/unbind', headers: { authorization: `Bearer ${token}` }, payload: { confirmation } })
  return { store, revoked, disconnected, audits, unbind }
}

test('gateway unbind revokes device sessions and shares, tombstones UUID, and safely replays a lost response', async t => {
  const f = await gatewayFixture(t)
  const first = await f.unbind()
  assert.equal(first.statusCode, 200)
  assert.deepEqual(first.json(), { unbound: true, deviceId: 'device-fixture' })
  assert.equal(await f.store.get('device:device-fixture'), null)
  assert.equal((await f.store.get('device-unbound:device-fixture')).owner, 'owner')
  assert.equal(await f.store.get('identity-session:bound'), null)
  assert.equal(await f.store.get('identity-session:other'), null)
  assert.ok(await f.store.get('identity-session:browser'), 'client logins are not accidentally revoked')
  assert.deepEqual(f.disconnected, ['device-fixture'])
  assert.equal(f.audits.length, 1)
  assert.equal((await f.unbind()).statusCode, 200, 'exact retired bearer can replay only its completed revocation')
  assert.equal(f.audits.length, 1)
  assert.equal((await f.unbind('bound', 'wrong-device')).statusCode, 400)
})

test('gateway unbind rejects browser tokens, administrators, different bound devices, and missing confirmation', async t => {
  const f = await gatewayFixture(t)
  assert.equal((await f.unbind('browser')).statusCode, 401)
  assert.equal((await f.unbind('other')).statusCode, 403)
  assert.equal((await f.unbind('wrong')).statusCode, 403)
  assert.equal((await f.unbind('bound', '')).statusCode, 400)
  assert.ok(await f.store.get('device:device-fixture'))
  assert.equal(await f.store.get('device-unbound:device-fixture'), null)
  assert.equal((await f.unbind('fresh')).statusCode, 200, 'fresh same-owner device login need not expose old shares before revocation')
})

test('gateway unbind resumes tombstoned cleanup when a crash happens after partial revocation', async t => {
  const f = await gatewayFixture(t)
  const originalDelete = f.store.delete.bind(f.store)
  let failOnce = true
  f.store.delete = async key => { if (key === 'device:device-fixture' && failOnce) { failOnce = false; throw new Error('fixture disk failure') }; return originalDelete(key) }
  assert.equal((await f.unbind()).statusCode, 500)
  assert.ok(await f.store.get('device-unbound:device-fixture'))
  assert.equal(await f.store.get('identity-session:bound'), null)
  assert.equal((await f.unbind()).statusCode, 200, 'pending receipt authorizes continuation without resurrecting bearer')
  assert.equal(await f.store.get('device:device-fixture'), null)
})

test('expired unbind receipts require fresh same-owner device authentication for recovery', async t => {
  const f = await gatewayFixture(t)
  assert.equal((await f.unbind()).statusCode, 200)
  for (const { key, ...value } of await f.store.list('device-unbind-receipt:')) await f.store.put(key, { ...value, expires: Date.now() - 1 })
  assert.equal((await f.unbind()).statusCode, 401)
  assert.equal((await f.unbind('fresh')).statusCode, 200)
  assert.equal(await f.store.get('device:device-fixture'), null)
})

test('local unbind fails closed offline, then rotates identity and preserves local history on retry', async t => {
  const root = await localFixture(t)
  await assert.rejects(unbindLocalDevice({ root, confirmation: 'incorrect', credentials: credentials(), revokeRemote: () => assert.fail('must not revoke') }), { code: 'confirmation_required' })
  await assert.rejects(unbindLocalDevice({ root, confirmation: 'device-fixture', credentials: credentials(), revokeRemote: () => { throw new Error('fixture offline') } }), /fixture offline/)
  const paused = await readDeviceLifecycle({ root })
  assert.equal(paused.identity.id, 'device-fixture')
  assert.equal(paused.identity.owner, 'owner')
  assert.equal(paused.pending.phase, 'revoking')
  await assert.rejects(prepareRemoteBinding({ bindOwner: () => assert.fail('binding must stay blocked') }, credentials(), { root }), { code: 'unbind_pending' })
  const result = await unbindLocalDevice({ root, confirmation: 'device-fixture', credentials: credentials(), revokeRemote: async () => ({ unbound: true, deviceId: 'device-fixture' }) })
  assert.notEqual(result.nextDeviceId, 'device-fixture')
  const complete = await readDeviceLifecycle({ root })
  assert.equal(complete.pending, null)
  assert.equal(complete.identity.id, result.nextDeviceId)
  assert.equal(complete.identity.owner, null)
  assert.equal(complete.identity.historyOwner, 'owner')
  assert.equal(JSON.parse(await readFile(path.join(root, 'remote-credentials.json'), 'utf8')), null)
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'history-sentinel.json'), 'utf8')), { preserved: true })
})

test('account/gateway transfer needs explicit local history consent and cannot bypass current binding', async t => {
  const root = await localFixture(t)
  const next = { ...credentials(), profile: { id: 'new-owner', organization: 'new-org', name: 'New owner' } }
  await assert.rejects(acceptRemoteIdentity(next, { root }), { code: 'owner_conflict' })
  await assert.rejects(acceptRemoteIdentity(next, { root, transferHistory: true }), { code: 'owner_conflict' })
  await assert.rejects(acceptRemoteIdentity({ ...credentials(), gateway: 'https://other.example' }, { root }), { code: 'owner_conflict' })
  await unbindLocalDevice({ root, confirmation: 'device-fixture', credentials: credentials(), revokeRemote: async () => ({ unbound: true, deviceId: 'device-fixture' }) })
  await assert.rejects(acceptRemoteIdentity(next, { root }), { code: 'history_transfer_required' })
  await acceptRemoteIdentity(next, { root, transferHistory: true })
  await acceptRemoteIdentity(next, { root })
  assert.equal((await readDeviceLifecycle({ root })).identity.historyOwner, 'new-owner')
  assert.equal((await readDeviceLifecycle({ root })).identity.historyOrganization, 'new-org')
})

test('local revocation recovers after identity rotation but before credential cleanup, without repeating server mutation', async t => {
  const root = await localFixture(t)
  await assert.rejects(unbindLocalDevice({ root, confirmation: 'device-fixture', credentials: credentials(), revokeRemote: async () => ({ unbound: true, deviceId: 'device-fixture' }), clearCredentials: () => { throw new Error('fixture write failure') } }), /fixture write failure/)
  const interrupted = await readDeviceLifecycle({ root })
  assert.equal(interrupted.pending.phase, 'revoked')
  assert.notEqual(interrupted.identity.id, 'device-fixture')
  const result = await unbindLocalDevice({ root, confirmation: 'device-fixture', revokeRemote: () => assert.fail('remote mutation already acknowledged') })
  assert.equal(result.nextDeviceId, interrupted.identity.id)
  assert.equal((await readDeviceLifecycle({ root })).pending, null)
  const again = await unbindLocalDevice({ root, confirmation: result.nextDeviceId, revokeRemote: () => assert.fail('already unbound') })
  assert.equal(again.alreadyUnbound, true)
})

test('local binding lock rejects concurrent operations and releases only its own lock', async t => {
  const root = await localFixture(t)
  const release = await acquireDeviceLifecycleLock({ root })
  await assert.rejects(acquireDeviceLifecycleLock({ root }), { code: 'lifecycle_busy' })
  await release()
  const next = await acquireDeviceLifecycleLock({ root })
  await release()
  await assert.rejects(acquireDeviceLifecycleLock({ root }), { code: 'lifecycle_busy' })
  await next()
})

test('an active standalone device service blocks local identity mutation', async t => {
  const root = await localFixture(t), lock = await acquireProcessLock(path.join(root, 'device', 'device.lock'))
  try {
    await assert.rejects(unbindLocalDevice({ root, confirmation: 'device-fixture', credentials: credentials(), revokeRemote: () => assert.fail('cannot revoke while a local service owns state') }), { code: 'device_in_use' })
    await assert.rejects(acceptRemoteIdentity(credentials(), { root, transferHistory: true }), { code: 'device_in_use' })
    assert.equal((await readDeviceLifecycle({ root })).pending, null)
  } finally { await lock.release() }
})

test('corrupt local identity is not silently treated as a first binding', async t => {
  const root = await localFixture(t)
  await writePrivateFile(path.join(root, 'device', 'identity.json'), '{broken')
  await assert.rejects(acceptRemoteIdentity(credentials(), { root }), SyntaxError)
})
