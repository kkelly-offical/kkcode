import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { createHash, randomUUID } from 'node:crypto'
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

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

async function oidcFixture(run) {
  const idp = Fastify(), grants = new Map()
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = await exportJWK(publicKey); jwk.kid = 'fixture'
  let issuer
  idp.get('/.well-known/openid-configuration', async () => ({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_post'], code_challenge_methods_supported: ['S256'] }))
  idp.get('/jwks', async () => ({ keys: [jwk] }))
  idp.get('/authorize', async (req, reply) => { const code = randomUUID(); grants.set(code, req.query); const target = new URL(req.query.redirect_uri); target.searchParams.set('state', req.query.state); target.searchParams.set('code', code); return reply.redirect(target.href) })
  idp.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body))))
  idp.post('/token', async (req, reply) => {
    const grant = grants.get(req.body.code); grants.delete(req.body.code)
    if (!grant || createHash('sha256').update(req.body.code_verifier).digest('base64url') !== grant.code_challenge) return reply.code(400).send({ error: 'invalid_grant' })
    return { access_token: 'fixture-access', token_type: 'Bearer', expires_in: 3600, id_token: await new SignJWT({ nonce: grant.nonce, name: 'Updated Owner', email: 'updated@example.test' }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setSubject('owner').setAudience('kkcode').setIssuer(issuer).setIssuedAt().setExpirationTime('5m').sign(privateKey) }
  })
  issuer = await idp.listen({ host: '127.0.0.1', port: 0 })
  let app
  try {
    const store = new MemoryStore()
    const member = { id: identityHash(`${issuer}\0owner`), organization: 'QA', name: 'Previous Owner', email: 'previous@example.test', admin: false, disabled: false }
    const administrator = { id: 'admin', organization: 'QA', name: 'Admin', admin: true, disabled: false }
    await store.put(`account:${member.id}`, member)
    await store.put('account:admin', administrator)
    await store.put('identity-session:admin', { id: 'admin', accountId: 'admin', kind: 'client', expires: Date.now() + 60000 })
    await store.put(`token:${identityHash('fixture-admin')}`, { sessionId: 'admin', account: administrator, kind: 'client', expires: Date.now() + 60000 })
    app = await createGateway({ origin: 'http://localhost', issuer, clientId: 'kkcode', clientSecret: 'fixture-secret', store, dev: true, organization: 'QA' })
    async function prepareCallback() {
      const device = await app.inject({ method: 'POST', url: '/auth/device', headers: { host: 'localhost' }, payload: { kind: 'device', name: 'QA device' } })
      assert.equal(device.statusCode, 200, device.body)
      const flow = device.json()
      const start = await app.inject({ url: `/auth/start?code=${flow.user_code}`, headers: { host: 'localhost' } })
      assert.equal(start.statusCode, 302, start.body)
      const stateCookie = start.headers['set-cookie'].split(';')[0]
      const authorized = await fetch(start.headers.location, { redirect: 'manual' })
      assert.equal(authorized.status, 302)
      const target = new URL(authorized.headers.get('location'))
      return { flow, callback: () => app.inject({ url: `${target.pathname}${target.search}`, headers: { host: 'localhost', cookie: stateCookie } }) }
    }
    const disableMember = () => app.inject({ method: 'POST', url: `/api/v1/admin/members/${member.id}/disable`, headers: { host: 'localhost', authorization: 'Bearer fixture-admin' }, payload: {} })
    await run({ app, store, member, prepareCallback, disableMember })
  } finally { await app?.close(); await idp.close() }
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

test('OIDC callback refreshes mutable profile fields for an active member', { timeout: 10000 }, () => oidcFixture(async ({ store, member, prepareCallback }) => {
  const { callback } = await prepareCallback()
  const result = await callback()
  assert.equal(result.statusCode, 200, result.body)
  const saved = await store.get(`account:${member.id}`)
  assert.equal(saved.name, 'Updated Owner')
  assert.equal(saved.email, 'updated@example.test')
  assert.equal(saved.disabled, false)
  assert.equal((await store.list('identity-session:')).filter(session => session.accountId === member.id).length, 1)
}))

test('OIDC callback cannot overwrite a concurrent membership disable', { timeout: 10000 }, () => oidcFixture(async ({ store, member, prepareCallback, disableMember }) => {
  const { callback } = await prepareCallback()
  const get = store.get.bind(store), reached = deferred(), release = deferred()
  let armed = true
  store.get = async key => {
    const value = await get(key)
    if (armed && key === `account:${member.id}`) { armed = false; reached.resolve(); await release.promise }
    return value
  }
  const pending = callback()
  await reached.promise
  try { assert.equal((await disableMember()).statusCode, 200) } finally { release.resolve() }
  const result = await pending
  assert.equal(result.statusCode, 403, result.body)
  assert.equal((await store.get(`account:${member.id}`)).disabled, true)
  assert.equal((await store.list('identity-session:')).some(session => session.accountId === member.id), false)
}))

test('OIDC callback rechecks membership immediately before issuing browser credentials', { timeout: 10000 }, () => oidcFixture(async ({ store, member, prepareCallback, disableMember }) => {
  const { callback } = await prepareCallback()
  const comparePut = store.comparePut.bind(store), reached = deferred(), release = deferred()
  let armed = true
  store.comparePut = async (key, expected, value) => {
    const updated = await comparePut(key, expected, value)
    if (armed && updated && key.startsWith('login-code:') && value.confirmation) { armed = false; reached.resolve(); await release.promise }
    return updated
  }
  const pending = callback()
  await reached.promise
  try { assert.equal((await disableMember()).statusCode, 200) } finally { release.resolve() }
  const result = await pending
  assert.equal(result.statusCode, 403, result.body)
  assert.equal((await store.get(`account:${member.id}`)).disabled, true)
  assert.equal((await store.list('identity-session:')).some(session => session.accountId === member.id), false)
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
