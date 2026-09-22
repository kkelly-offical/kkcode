import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import net from 'node:net'
import WebSocket from 'ws'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createGateway } from '../src/remote/gateway.mjs'
import { MemoryStore } from '../src/remote/store.mjs'
import { DeviceService } from '../src/device/service.mjs'
import { connectRelay } from '../src/remote/client.mjs'

const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) }) })

class SseClient {
  constructor(response) {
    this.response = response
    this.reader = response.body.getReader()
    this.buffer = ''
    this.frames = []
    this.waiters = []
    this.done = false
    this.pump = this.read()
  }
  async read() {
    try {
      while (true) {
        const { done, value } = await this.reader.read()
        if (done) break
        this.buffer += Buffer.from(value).toString('utf8')
        let index
        while ((index = this.buffer.indexOf('\n\n')) >= 0) {
          const raw = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 2)
          const frame = {}
          for (const line of raw.split('\n')) {
            if (line.startsWith(':')) continue
            const colon = line.indexOf(':')
            if (colon < 0) continue
            const field = line.slice(0, colon), value = line.slice(colon + 1).replace(/^ /, '')
            if (field === 'data') frame.data = frame.data === undefined ? value : `${frame.data}\n${value}`
            else frame[field] = value
          }
          if (frame.data === undefined) continue
          try { frame.json = JSON.parse(frame.data) } catch { /* keep raw */ }
          this.frames.push(frame)
          this.wake()
        }
      }
    } catch { /* closed by server */ }
    this.done = true
    this.wake()
  }
  wake() { const waiters = this.waiters.splice(0); for (const resolve of waiters) resolve() }
  async next(predicate = () => true, timeoutMs = 4000) {
    const start = this.frames.findIndex(predicate)
    if (start >= 0) return this.frames.splice(0, start + 1).pop()
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), timeoutMs)
      const check = () => {
        const index = this.frames.findIndex(predicate)
        if (index >= 0 || this.done) { clearTimeout(timer); resolve(index >= 0 ? this.frames.splice(0, index + 1).pop() : null); return }
        this.waiters.push(check)
      }
      this.waiters.push(check)
    })
  }
  close() { return this.reader.cancel().catch(() => {}) }
}

/** Stub OIDC provider; each token exchange gets the next subject in line. */
async function stubIdentityProvider(subjects) {
  const idp = Fastify()
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = await exportJWK(publicKey); jwk.kid = 'fixture'
  const grants = new Map()
  let issuer, exchange = 0
  idp.get('/.well-known/openid-configuration', async () => ({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_post'], code_challenge_methods_supported: ['S256'] }))
  idp.get('/jwks', async () => ({ keys: [jwk] }))
  idp.get('/authorize', async (req, reply) => { const code = randomUUID(); grants.set(code, req.query); const url = new URL(req.query.redirect_uri); url.searchParams.set('state', req.query.state); url.searchParams.set('code', code); return reply.redirect(url.href) })
  idp.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body))))
  idp.post('/token', async (req, reply) => {
    const grant = grants.get(req.body.code); grants.delete(req.body.code)
    if (!grant || createHash('sha256').update(req.body.code_verifier).digest('base64url') !== grant.code_challenge) return reply.code(400).send({ error: 'invalid_grant' })
    const subject = subjects[Math.min(exchange++, subjects.length - 1)]
    return { access_token: 'fixture-access', token_type: 'Bearer', expires_in: 3600, id_token: await new SignJWT({ nonce: grant.nonce, name: `Fixture ${subject}` }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setSubject(subject).setAudience('kkcode').setIssuer(issuer).setIssuedAt().setExpirationTime('5m').sign(privateKey) }
  })
  issuer = await idp.listen({ host: '127.0.0.1', port: 0 })
  return { idp, issuer: await issuer }
}

/** Runs the device-authorization flow; returns the flow's browser cookie and, on token exchange, the issued credentials. */
async function loginFlow(origin, { kind = 'device', name = 'QA device' } = {}) {
  const post = (p, body, headers = {}) => fetch(origin + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const flow = await (await post('/auth/device', { kind, name })).json()
  const start = await fetch(`${origin}/auth/start?code=${flow.user_code}`, { redirect: 'manual' })
  const stateCookie = start.headers.get('set-cookie').split(';')[0]
  const authorized = await fetch(start.headers.get('location'), { redirect: 'manual' })
  const callback = await fetch(authorized.headers.get('location'), { headers: { Cookie: stateCookie }, redirect: 'manual' })
  const html = await callback.text(), confirmation = /name="confirmation" value="([^"]+)"/.exec(html)[1]
  const browserCookie = callback.headers.get('set-cookie').split(';')[0]
  assert.equal((await post('/auth/confirm', { code: flow.user_code, confirmation }, { Cookie: browserCookie, Origin: origin })).status, 200)
  const credentials = await (await post('/auth/token', { device_code: flow.device_code })).json()
  return { browserCookie, credentials }
}

async function setup(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'kkcode-sse-gateway-'))
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = path.join(temp, 'state')
  const { idp, issuer } = await stubIdentityProvider(['owner', 'guest'])
  const store = new MemoryStore()
  const port = await freePort(), origin = `http://127.0.0.1:${port}`
  const gateway = await createGateway({ origin, issuer, clientId: 'kkcode', clientSecret: 'fixture-secret', store, dev: true, organization: 'QA', streaming: { pollMs: 60, syncMs: 120, statusMs: 60 } })
  await gateway.listen({ host: '127.0.0.1', port })
  t.after(async () => {
    await gateway.close(); await idp.close()
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(temp, { recursive: true, force: true })
  })
  return { temp, origin, store }
}

test('gateway session stream: pushed rows, replay, gap, session isolation and share revocation', { timeout: 30000 }, async t => {
  const { temp, origin } = await setup(t)
  const owner = await loginFlow(origin)
  const service = await new DeviceService({ cwd: temp, roots: [temp], retention: { replay: { maxEvents: 4, sessionBytes: 65536, totalBytes: 1048576, maxAgeMs: 86400000, maxEventBytes: 65536, maxResponseBytes: 1048576 } } }).initialize()
  let relay = await connectRelay({ service, credentials: { ...owner.credentials, gateway: origin, expiresAt: Date.now() + 3600000 } })
  t.after(async () => { relay?.close(); await service.close() })
  const deviceId = service.metadata.id
  const ownerHeaders = { Cookie: owner.browserCookie, Origin: origin }
  for (let i = 0; i < 50; i++) { const list = await (await fetch(`${origin}/api/v1/devices`, { headers: ownerHeaders })).json(); if (list[0]?.online) break; await new Promise(r => setTimeout(r, 20)) }
  const open = (query = '', headers = ownerHeaders) => fetch(`${origin}/api/v1/devices/${deviceId}/events/stream${query}`, { headers })

  let client = new SseClient(await open('?sessionId=s1'))
  t.after(() => client.close())
  const hello = await client.next(frame => frame.event === 'connected')
  assert.ok(hello, 'hello arrives through the relay')
  assert.equal(hello.json.sessionId, 's1')
  assert.equal(hello.json.running, false)

  // Live push: rows recorded on the device arrive without polling.
  await service.record({ type: 'stream.text.delta', sessionId: 's1', turnId: 't1', payload: { text: 'he', step: 1 } })
  await service.record({ type: 'stream.text.delta', sessionId: 's2', turnId: 't9', payload: { text: 'stray', step: 1 } })
  await service.record({ type: 'stream.text.delta', sessionId: 's1', turnId: 't1', payload: { text: 'llo', step: 1 } })
  const first = await client.next(frame => frame.event === 'stream.text.delta')
  const second = await client.next(frame => frame.event === 'stream.text.delta')
  assert.equal(first.json.payload.text, 'he'); assert.equal(first.id, '1')
  assert.equal(second.json.payload.text, 'llo'); assert.equal(second.id, '2')

  // Reconnect replay through the relay journal path.
  await client.close()
  await service.record({ type: 'stream.text.delta', sessionId: 's1', turnId: 't1', payload: { text: 'again', step: 1 } })
  client = new SseClient(await open('?sessionId=s1', { ...ownerHeaders, 'Last-Event-ID': '2' }))
  const replayed = await client.next(frame => frame.event === 'stream.text.delta')
  assert.equal(replayed.id, '3')
  assert.equal(replayed.json.payload.text, 'again')
  await client.close()

  // Rotated journal → replay.gap frame, stream continues.
  for (const text of ['d', 'e', 'f']) await service.record({ type: 'stream.text.delta', sessionId: 's1', turnId: 't1', payload: { text, step: 1 } })
  client = new SseClient(await open('?sessionId=s1&after=0'))
  const gap = await client.next(frame => frame.event === 'replay.gap')
  assert.ok(gap, 'gap is signalled')
  assert.ok((await client.next(frame => frame.event === 'stream.text.delta')), 'rows continue after the gap')
  await client.close()

  // Shared account: granted session streams, others forbidden; revocation closes the stream.
  const guest = await loginFlow(origin, { kind: 'client', name: 'Guest browser' })
  const guestProfile = await (await fetch(`${origin}/api/v1/profile`, { headers: { Cookie: guest.browserCookie, Origin: origin } })).json()
  const guestHeaders = { Cookie: guest.browserCookie, Origin: origin }
  const share = await fetch(`${origin}/api/v1/devices/${deviceId}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ownerHeaders }, body: JSON.stringify({ accountId: guestProfile.id, sessionId: 's1', role: 'view' }) })
  assert.equal(share.status, 200)
  assert.equal((await open('?sessionId=s2', guestHeaders)).status, 403)
  const guestClient = new SseClient(await open('?sessionId=s1', guestHeaders))
  assert.ok(await guestClient.next(frame => frame.event === 'connected'), 'shared session stream opens')
  await service.record({ type: 'stream.text.delta', sessionId: 's1', turnId: 't1', payload: { text: 'shared', step: 1 } })
  // The fresh stream first replays the visible backlog, then the live row.
  assert.ok(await guestClient.next(frame => frame.event === 'stream.text.delta' && frame.json.payload.text === 'shared'), 'granted session rows reach the shared stream')
  const revoke = await fetch(`${origin}/api/v1/devices/${deviceId}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ownerHeaders }, body: JSON.stringify({ accountId: guestProfile.id, sessionId: 's1', role: 'remove' }) })
  assert.equal(revoke.status, 200)
  assert.equal(await guestClient.next(() => true, 4000), null, 'share revocation closes the stream')
  await guestClient.close()

  // turn.start refreshes the envelope state immediately, not at the next tick.
  client = new SseClient(await open('?sessionId=s1'))
  assert.ok(await client.next(frame => frame.event === 'connected'))
  service.turns.set('s1', { controller: new AbortController(), client: 'local', turnId: 't7' })
  await service.record({ type: 'turn.start', sessionId: 's1', turnId: 't7', payload: { prompt: 'run' } })
  assert.ok(await client.next(frame => frame.event === 'session.state' && frame.json.running === true, 2000), 'session.state running:true follows the turn.start row immediately')
  service.turns.delete('s1')
  await client.close()
})

test('gateway device stream: online/offline fast path, active-session diffs, no content leak to shared viewers', { timeout: 30000 }, async t => {
  const { temp, origin } = await setup(t)
  const owner = await loginFlow(origin)
  const service = await new DeviceService({ cwd: temp, roots: [temp] }).initialize()
  let relay = await connectRelay({ service, credentials: { ...owner.credentials, gateway: origin, expiresAt: Date.now() + 3600000 } })
  t.after(async () => { relay?.close(); await service.close() })
  const deviceId = service.metadata.id
  const ownerHeaders = { Cookie: owner.browserCookie, Origin: origin }
  for (let i = 0; i < 50; i++) { const list = await (await fetch(`${origin}/api/v1/devices`, { headers: ownerHeaders })).json(); if (list[0]?.online) break; await new Promise(r => setTimeout(r, 20)) }

  const client = new SseClient(await fetch(`${origin}/api/v1/devices/${deviceId}/events/stream`, { headers: ownerHeaders }))
  t.after(() => client.close())
  const hello = await client.next(frame => frame.event === 'connected')
  assert.equal(hello.json.online, true)
  assert.equal(hello.json.deviceId, deviceId)

  // Active session appears via the status diff (no content payload).
  service.turns.set('s1', { controller: new AbortController(), client: 'local', turnId: 't1' })
  const started = await client.next(frame => frame.event === 'session.status' && frame.json.sessionId === 's1')
  assert.ok(started, 'session.status running arrives')
  assert.equal(started.json.running, true)
  assert.equal('prompt' in started.json, false)

  // Device events (model catalog) reach owner streams, flat per the contract.
  service.emitDeviceEvent('models.updated', { provider: 'default', source: 'network', stale: false, models: [{ id: 'm1', origin: 'auto' }] })
  assert.equal((await client.next(frame => frame.event === 'models.updated')).json.models[0].origin, 'auto')
  await service.record({ type: 'mcp.loaded', payload: { ok: true, configured: 1, connected: 1, toolCount: 3, failed: [] } })
  assert.equal((await client.next(frame => frame.event === 'mcp.loaded')).json.toolCount, 3)

  // Relay drop → device.offline; re-register → device.online.
  relay.close()
  assert.equal((await client.next(frame => frame.event === 'device.offline'))?.json.deviceId, deviceId)
  relay = await connectRelay({ service, credentials: { ...owner.credentials, gateway: origin, expiresAt: Date.now() + 3600000 } })
  assert.equal((await client.next(frame => frame.event === 'device.online'))?.json.deviceId, deviceId)

  // A shared viewer gets session.status only for granted sessions and no device-scope events.
  const guest = await loginFlow(origin, { kind: 'client', name: 'Guest browser' })
  const guestProfile = await (await fetch(`${origin}/api/v1/profile`, { headers: { Cookie: guest.browserCookie, Origin: origin } })).json()
  const guestHeaders = { Cookie: guest.browserCookie, Origin: origin }
  assert.equal((await fetch(`${origin}/api/v1/devices/${deviceId}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ownerHeaders }, body: JSON.stringify({ accountId: guestProfile.id, sessionId: 's1', role: 'view' }) })).status, 200)
  const guestClient = new SseClient(await fetch(`${origin}/api/v1/devices/${deviceId}/events/stream`, { headers: guestHeaders }))
  t.after(() => guestClient.close())
  const guestHello = await guestClient.next(frame => frame.event === 'connected')
  assert.ok(guestHello, 'shared device stream opens')
  assert.deepEqual(guestHello.json.active, ['s1'], 'shared hello is filtered to granted sessions')
  service.emitDeviceEvent('settings.updated', {})
  await service.record({ type: 'mcp.loaded', payload: { ok: true, configured: 1, connected: 1, toolCount: 3, failed: [] } })
  service.turns.set('s2', { controller: new AbortController(), client: 'local', turnId: 't2' })
  const leaked = await guestClient.next(frame => ['settings.updated', 'models.updated', 'mcp.loaded'].includes(frame.event) || (frame.event === 'session.status' && frame.json.sessionId === 's2'), 500)
  assert.equal(leaked, null, 'no device-scope or ungranted session frames leak to shared viewers')
})

test('gateway session stream handshake: offline device → 503, unknown device → 403', { timeout: 30000 }, async t => {
  const { origin, store } = await setup(t)
  const owner = await loginFlow(origin)
  const ownerHeaders = { Cookie: owner.browserCookie, Origin: origin }
  await store.put('device:offdev', { id: 'offdev', name: 'Offline device', owner: owner.credentials.profile.id, organization: 'QA', shares: {} })
  const offline = await fetch(`${origin}/api/v1/devices/offdev/events/stream?sessionId=s1`, { headers: ownerHeaders })
  assert.equal(offline.status, 503)
  assert.equal((await offline.json()).error.code, 'device_offline')
  assert.equal((await fetch(`${origin}/api/v1/devices/nope/events/stream?sessionId=s1`, { headers: ownerHeaders })).status, 403)
  // Device streams still open on an offline device and report online:false.
  const client = new SseClient(await fetch(`${origin}/api/v1/devices/offdev/events/stream`, { headers: ownerHeaders }))
  t.after(() => client.close())
  const hello = await client.next(frame => frame.event === 'connected')
  assert.equal(hello.json.online, false)
  assert.deepEqual(hello.json.active, [])
})

test('gateway stream closes when the identity session expires naturally (no revoke)', { timeout: 30000 }, async t => {
  const { origin, store } = await setup(t)
  const owner = await loginFlow(origin)
  const ownerHeaders = { Cookie: owner.browserCookie, Origin: origin }
  await store.put('device:offdev', { id: 'offdev', name: 'Offline device', owner: owner.credentials.profile.id, organization: 'QA', shares: {} })
  const client = new SseClient(await fetch(`${origin}/api/v1/devices/offdev/events/stream`, { headers: ownerHeaders }))
  t.after(() => client.close())
  assert.ok(await client.next(frame => frame.event === 'connected'), 'stream opens')
  // Expire the browser login session without revoking it; the next sync tick must close the stream.
  const sessions = await store.list('identity-session:')
  const browser = sessions.find(session => session.accountId === owner.credentials.profile.id && session.kind === 'client')
  assert.ok(browser, 'browser identity session found')
  await store.put(browser.key, { ...browser, expires: Date.now() - 1 })
  assert.equal(await client.next(() => true, 4000), null, 'stream closes on natural session expiry')
  assert.ok(await Promise.race([client.pump.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 4000))]), 'stream ends')
})

test('gateway session stream falls back to journal sync for devices without push support', { timeout: 30000 }, async t => {
  const { origin } = await setup(t)
  const owner = await loginFlow(origin)
  const ownerHeaders = { Cookie: owner.browserCookie, Origin: origin }
  // A legacy device: no features, answers events.list from an in-memory journal.
  const journal = []
  const legacy = new WebSocket(`${origin.replace(/^http/, 'ws')}/relay/device`, { headers: { Authorization: `Bearer ${owner.credentials.access_token}` } })
  t.after(() => legacy.close())
  await new Promise((resolve, reject) => { legacy.once('open', resolve); legacy.once('error', reject) })
  legacy.send(JSON.stringify({ type: 'register', device: { id: 'legacydev', name: 'Legacy device' } }))
  legacy.on('message', raw => {
    const message = JSON.parse(raw.toString())
    if (message.type !== 'request' || message.request.method !== 'events.list') return
    const after = Number(message.request.params?.after) || 0
    legacy.send(JSON.stringify({ type: 'response', id: message.id, result: { events: journal.filter(row => row.seq > after), earliest: 1, cursor: journal.at(-1)?.seq || 0, gap: false, running: false, control: null, approvals: [], pendingApprovalCount: 0 } }))
  })
  for (let i = 0; i < 50; i++) { const list = await (await fetch(`${origin}/api/v1/devices`, { headers: ownerHeaders })).json(); if (list[0]?.online) break; await new Promise(r => setTimeout(r, 20)) }
  const client = new SseClient(await fetch(`${origin}/api/v1/devices/legacydev/events/stream?sessionId=leg1`, { headers: ownerHeaders }))
  t.after(() => client.close())
  assert.ok(await client.next(frame => frame.event === 'connected'), 'hello arrives via journal sync')
  journal.push({ id: randomUUID(), sessionId: 'leg1', seq: 1, timestamp: Date.now(), schemaVersion: '1', type: 'stream.text.delta', turnId: 't1', payload: { text: 'polled', step: 1 } })
  const frame = await client.next(frame => frame.event === 'stream.text.delta')
  assert.ok(frame, 'row delivered without device push support')
  assert.equal(frame.json.payload.text, 'polled')
  assert.equal(frame.id, '1')
})
