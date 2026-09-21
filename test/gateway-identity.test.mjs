import test from 'node:test'
import assert from 'node:assert/strict'
import { createGateway } from '../src/remote/gateway.mjs'
import { MemoryStore, PostgresStore } from '../src/remote/store.mjs'
import { identityHash, hasOrganizationRole } from '../src/remote/identity.mjs'
import { PACKAGE_VERSION } from '../src/version.mjs'

async function fixture(run) {
  const store = new MemoryStore()
  const account = { id: 'owner', name: 'Owner', organization: 'QA', admin: false }
  const colleague = { id: 'viewer', name: 'Viewer', organization: 'QA', admin: false }
  const administrator = { id: 'admin', name: 'Admin', organization: 'QA', admin: true }
  for (const item of [account, colleague, administrator]) await store.put(`account:${item.id}`, item)
  for (const [id, member, kind] of [['a', account, 'client'], ['b', account, 'client'], ['d', account, 'device'], ['v', colleague, 'client'], ['admin', administrator, 'client']]) {
    await store.put(`identity-session:${id}`, { id, accountId: member.id, kind, expires: Date.now() + 60000 })
    await store.put(`token:${identityHash(`fixture-${id}`)}`, { sessionId: id, account: member, kind, expires: Date.now() + 60000 })
    await store.put(`refresh:${identityHash(`fixture-refresh-${id}`)}`, { sessionId: id, expires: Date.now() + 60000 })
  }
  await store.put('device:computer', { id: 'computer', name: 'Computer', owner: 'owner', organization: 'QA' })
  const app = await createGateway({ origin: 'http://localhost', issuer: 'https://idp.invalid', clientId: 'test', dev: true, oidcConfig: {}, store, organization: 'QA' })
  const request = (url, token = 'a', payload) => app.inject({ method: payload === undefined ? 'GET' : 'POST', url, headers: { host: 'localhost', authorization: `Bearer fixture-${token}` }, ...(payload === undefined ? {} : { payload }) })
  try { await run({ app, store, request }) } finally { await app.close() }
}

test('gateway refresh rotation is single-use and keeps the stable controller session ID', () => fixture(async ({ request, store }) => {
  const results = await Promise.all([request('/auth/refresh', 'a', { refresh_token: 'fixture-refresh-a' }), request('/auth/refresh', 'a', { refresh_token: 'fixture-refresh-a' })])
  assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 401])
  const next = results.find(result => result.statusCode === 200).json()
  assert.equal((await store.get(`token:${identityHash(next.access_token)}`)).sessionId, 'a')
  assert.equal((await store.get(`refresh:${identityHash(next.refresh_token)}`)).sessionId, 'a')
}))

test('logging out one client does not revoke another browser or its foreground device', () => fixture(async ({ request, store }) => {
  assert.equal((await request('/auth/logout', 'a', {})).statusCode, 200)
  assert.equal((await request('/api/v1/profile', 'a')).statusCode, 401)
  assert.equal((await request('/api/v1/profile', 'b')).statusCode, 200)
  assert.ok(await store.get('identity-session:d'))
  assert.equal((await request('/auth/refresh', 'a', { refresh_token: 'fixture-refresh-a' })).statusCode, 401)
}))

test('administrator status does not imply private conversation access; sharing is explicit and revocable', () => fixture(async ({ request }) => {
  const status = { id: 'status-request', method: 'status' }
  assert.equal((await request('/api/v1/devices/computer/rpc', 'admin', status)).statusCode, 403)
  assert.equal((await request('/api/v1/devices', 'v')).json().length, 0)
  assert.equal((await request('/api/v1/devices/computer/share', 'v', { accountId: 'viewer', sessionId: 'one', role: 'view' })).statusCode, 403)
  assert.equal((await request('/api/v1/devices/computer/share', 'a', { accountId: 'viewer', sessionId: 'one', role: 'view' })).statusCode, 200)
  const shared = (await request('/api/v1/devices', 'v')).json()[0]
  assert.equal(shared.shared, true); assert.deepEqual(shared.permissions, { one: 'view' }); assert.equal(shared.shares, undefined)
  assert.equal((await request('/api/v1/devices/computer/rpc', 'v', { id: 'denied', method: 'settings.get' })).statusCode, 403)
  assert.equal((await request('/api/v1/devices/computer/rpc', 'v', { id: 'other-session', method: 'sessions.get', params: { sessionId: 'two' } })).statusCode, 403)
  await request('/api/v1/devices/computer/share', 'a', { accountId: 'viewer', sessionId: 'one', role: 'remove' })
  assert.equal((await request('/api/v1/devices', 'v')).json().length, 0)
}))

test('disabling organization membership revokes all its clients, refresh grants and device credentials', () => fixture(async ({ request, store }) => {
  assert.equal((await request('/api/v1/admin/members/owner/disable', 'v', {})).statusCode, 403)
  assert.equal((await request('/api/v1/admin/members/owner/disable', 'admin', {})).statusCode, 200)
  assert.equal((await request('/api/v1/profile', 'b')).statusCode, 401)
  assert.equal((await request('/auth/refresh', 'a', { refresh_token: 'fixture-refresh-a' })).statusCode, 401)
  assert.equal(await store.get('identity-session:d'), null)
  assert.equal((await store.get('account:owner')).disabled, true)
}))

test('memory-store compare-and-swap and one-shot take permit one concurrent winner', async () => {
  const store = new MemoryStore(), original = { value: 1 }
  await store.put('record', original)
  assert.deepEqual(await Promise.all([store.comparePut('record', original, { value: 2 }), store.comparePut('record', original, { value: 3 })]), [true, false])
  assert.deepEqual(await Promise.all([store.take('record'), store.take('record')]), [{ value: 2 }, null])
})

test('organization role mapping supports configurable OIDC claims and fails closed for malformed values', () => {
  assert.equal(hasOrganizationRole({ realm_access: { roles: ['kkcode-admin'] } }), true)
  assert.equal(hasOrganizationRole({ groups: ['enterprise-operators'] }, 'groups', 'enterprise-operators'), true)
  assert.equal(hasOrganizationRole({ roles: 'administrator' }, 'roles', 'administrator'), false)
  assert.equal(hasOrganizationRole({}, 'constructor.prototype.roles', 'administrator'), false)
  assert.equal(hasOrganizationRole({ realm_access: { roles: ['ordinary-user'] } }), false)
})

test('browser device grant exchange installs HttpOnly cookies without returning bearer secrets', () => fixture(async ({ request, store }) => {
  const account = await store.get('account:owner')
  await store.put(`login-code:${identityHash('browser-code')}`, { kind: 'client', account, confirmed: true, userCode: '12345678', lastPoll: 0, expires: Date.now() + 60000 })
  const result = await request('/auth/token', 'a', { device_code: 'browser-code', browser: true })
  assert.equal(result.statusCode, 200)
  assert.equal(result.json().authenticated, true)
  assert.equal(result.json().access_token, undefined)
  assert.equal(result.json().refresh_token, undefined)
  assert.ok(result.cookies.every(cookie => cookie.httpOnly))
  assert.equal(result.cookies.length, 2)
  await store.put(`login-code:${identityHash('device-code')}`, { kind: 'device', account, confirmed: true, userCode: '12345679', lastPoll: 0, expires: Date.now() + 60000 })
  assert.equal((await request('/auth/token', 'a', { device_code: 'device-code', browser: true })).statusCode, 400)
  assert.ok(await store.get(`login-code:${identityHash('device-code')}`))
}))

test('gateway metadata pruning expires grants and caps audit records while retaining binding tombstones', async () => {
  const store = new MemoryStore()
  await store.put('token:expired', { expires: 10 })
  await store.put('token:active', { expires: 200 })
  await store.put('login-user:12345678', { codeKey: 'login-code:missing' })
  await store.put('device-unbound:old', { unboundAt: 0 })
  for (let timestamp = 0; timestamp < 10; timestamp++) await store.put(`audit:${timestamp}`, { timestamp })
  await store.prune({ now: 100, auditRetentionMs: 95, maxAudit: 2 })
  assert.equal(await store.get('token:expired'), null)
  assert.ok(await store.get('token:active'))
  assert.equal(await store.get('login-user:12345678'), null)
  assert.ok(await store.get('device-unbound:old'))
  assert.deepEqual((await store.list('audit:')).map(value => value.timestamp), [8, 9])
})

test('concurrent sharing updates preserve both grants and reject prototype identifiers', () => fixture(async ({ request }) => {
  const results = await Promise.all(['first', 'second'].map(sessionId => request('/api/v1/devices/computer/share', 'a', { accountId: 'viewer', sessionId, role: 'view' })))
  assert.ok(results.every(result => result.statusCode === 200))
  assert.deepEqual((await request('/api/v1/devices', 'v')).json()[0].permissions, { first: 'view', second: 'view' })
  assert.equal((await request('/api/v1/devices/computer/share', 'a', { accountId: 'viewer', sessionId: '__proto__', role: 'control' })).statusCode, 400)
}))

test('shared control denies every owner-only attachment, branch, profile and configuration operation', () => fixture(async ({ request }) => {
  await request('/api/v1/devices/computer/share', 'a', { accountId: 'viewer', sessionId: 'one', role: 'control' })
  for (const method of ['attachments.upload', 'attachments.list', 'attachments.remove', 'branches.list', 'branches.create', 'branches.switch', 'profile.get', 'profile.update', 'settings.get', 'settings.update', 'models.discover', 'commands.run', 'sessions.create', 'sessions.configure', 'extensions.list', 'extensions.reload', 'folders.list', 'files.read']) {
    const response = await request('/api/v1/devices/computer/rpc', 'v', { id: method.replaceAll('.', '_'), method, params: { sessionId: 'one', path: '/etc/passwd', cwd: '/', profile: {}, data: '', branch: 'main' } })
    assert.equal(response.statusCode, 403, `${method}: ${response.body}`)
  }
  for (const answer of ['allow_always', 'allow_session']) assert.equal((await request('/api/v1/devices/computer/rpc', 'v', { id: answer, method: 'approvals.resolve', params: { sessionId: 'one', id: 'approval', answer } })).statusCode, 403)
}))

test('cross-organization credentials and prototype session grants cannot access private devices', () => fixture(async ({ request, store }) => {
  const viewer = await store.get('account:viewer')
  for (const sessionId of ['__proto__', 'constructor', 'toString']) assert.equal((await request('/api/v1/devices/computer/rpc', 'v', { id: 'prototype', method: 'sessions.get', params: { sessionId } })).statusCode, 403)
  await store.put('account:viewer', { ...viewer, organization: 'Other organization' })
  assert.equal((await request('/api/v1/profile', 'v')).statusCode, 403)
  assert.equal((await request('/api/v1/devices', 'v')).statusCode, 403)
  assert.equal((await request('/api/v1/devices/computer/share', 'a', { accountId: 'viewer', sessionId: 'one', role: 'control' })).statusCode, 403)
  // An existing stale grant cannot defeat the identity organization boundary.
  const device = await store.get('device:computer'); await store.put('device:computer', { ...device, shares: { viewer: { one: 'control' } } })
  assert.equal((await request('/api/v1/devices/computer/rpc', 'v', { id: 'foreign', method: 'sessions.get', params: { sessionId: 'one' } })).statusCode, 403)
  await store.put('device:computer', { ...device, organization: 'Previous organization' })
  assert.deepEqual((await request('/api/v1/devices', 'a')).json(), [])
  assert.equal((await request('/api/v1/devices/computer/rpc', 'a', { id: 'previous-org', method: 'status' })).statusCode, 403)
  assert.equal((await request('/api/v1/devices/computer/share', 'a', { accountId: 'viewer', sessionId: 'one', role: 'view' })).statusCode, 403)
}))

test('random bearer tokens share an unauthenticated IP limit and database readiness is checked separately', () => fixture(async ({ app, request, store }) => {
  let last
  for (let index = 0; index < 601; index++) last = await request('/api/v1/profile', `random-invalid-${index}`)
  assert.equal(last.statusCode, 429)
  assert.equal((await request('/api/v1/profile', 'a')).statusCode, 200, 'authenticated session has its own limit')
  const healthy = await app.inject({ url: '/health', headers: { host: 'localhost' } })
  assert.equal(healthy.statusCode, 200)
  assert.deepEqual(healthy.json(), { ok: true, version: PACKAGE_VERSION })
  const get = store.get.bind(store)
  store.get = async key => { if (key === 'health:probe') throw new Error('Database unavailable'); return get(key) }
  const unavailable = await app.inject({ url: '/health', headers: { host: 'localhost' } })
  assert.equal(unavailable.statusCode, 503)
  assert.deepEqual(unavailable.json(), { ok: false, version: PACKAGE_VERSION })
}))

test('PostgreSQL connection failures remain retryable and never expose database diagnostics', async () => {
  const store = new PostgresStore('postgresql://localhost/unused')
  store.pool.query = async () => { throw new Error('private database diagnostics') }
  try {
    assert.doesNotThrow(() => store.pool.emit('error', new Error('idle connection lost')))
    await assert.rejects(store.get('account:owner'), error => error.statusCode === 503 && error.code === 'database_unavailable' && !error.message.includes('private'))
  } finally { await store.close() }
})
