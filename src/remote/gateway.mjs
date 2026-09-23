import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import staticFiles from '@fastify/static'
import rateLimit from '@fastify/rate-limit'
import * as oidc from 'openid-client'
import { randomUUID } from 'node:crypto'
import { registerIdentity, identityHash as hash } from './identity.mjs'
import { fileURLToPath } from 'node:url'
import { PostgresStore, MemoryStore } from './store.mjs'
import { validateRequest, RELAY_FEATURE_EVENT_PUSH } from '../protocol/index.mjs'
import { createRelayCluster } from './cluster.mjs'
import { registerDeviceLifecycle } from './device-lifecycle.mjs'
import { PACKAGE_VERSION } from '../version.mjs'
import { registerSshProfiles } from './ssh-profiles.mjs'
import { GatewayEventHub } from './sse-hub.mjs'
import { SseWriter, isDeviceEvent, isJournalRow, streamCursor } from '../http/sse.mjs'

export async function createGateway({ origin, issuer, clientId, clientSecret, organization = 'default', databaseUrl, store, dev = false, oidcConfig, rolesClaim, adminRole, scopes, auditRetentionDays, auditMaxRecords, trustProxy = false, cluster: clusterOptions, streaming = {} } = {}) {
  if (!origin || (!dev && !origin.startsWith('https://'))) throw new Error('Gateway public origin must use HTTPS')
  if (!store) store = databaseUrl ? await new PostgresStore(databaseUrl).initialize() : dev ? new MemoryStore() : null
  if (!store) throw new Error('Production gateway requires PostgreSQL')
  const config = oidcConfig || await oidc.discovery(new URL(issuer), clientId, clientSecret, undefined, dev ? { execute: [oidc.allowInsecureRequests] } : undefined)
  const app = Fastify({ logger: false, bodyLimit: 6 * 1024 * 1024, trustProxy })
  await app.register(cookie); await app.register(websocket, { options: { maxPayload: 6 * 1024 * 1024 } }); await app.register(rateLimit, { max: 600, timeWindow: '1 minute', keyGenerator: async req => {
    const token = req.headers.authorization?.replace(/^Bearer /, '') || req.cookies?.kkcode_gateway
    const grant = token && await store.get(`token:${hash(token)}`)
    // Random invalid Authorization headers must not create unlimited buckets.
    return grant?.expires > Date.now() ? `session:${grant.sessionId}` : `ip:${req.ip}`
  } })
  const devices = new Map(), pending = new Map()
  async function sendLocal(deviceId, connectionId, request, principal) {
    const connection = devices.get(deviceId)
    if (!connection || connection.connectionId !== connectionId || connection.socket.readyState !== 1) throw Object.assign(new Error('The computer is offline'), { statusCode: 503 })
    const identity = await store.get(`identity-session:${connection.identitySessionId}`)
    if (!identity || identity.expires <= Date.now() || await store.get(`device-unbound:${deviceId}`)) throw Object.assign(new Error('Device login has been revoked'), { statusCode: 503 })
    if (cluster && !await cluster.owns(deviceId, connectionId)) throw Object.assign(new Error('Device route changed'), { statusCode: 503 })
    const id = randomUUID()
    const wire = JSON.stringify({ type: 'request', id, request, principal }), bytes = Buffer.byteLength(wire)
    let devicePending = 0, pendingBytes = 0
    for (const job of pending.values()) { pendingBytes += job.bytes; if (job.deviceId === deviceId) devicePending++ }
    if (pending.size >= 256 || devicePending >= 64 || pendingBytes + bytes > 64 * 1024 * 1024 || connection.socket.bufferedAmount > 8 * 1024 * 1024) throw Object.assign(new Error('Device relay is busy; retry with the same request ID'), { statusCode: 429 })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('Device response timed out; execution outcome may be unknown'), { statusCode: 504 })) }, 30000)
      pending.set(id, { resolve, reject, timer, deviceId, bytes, socket: connection.socket })
      connection.socket.send(wire, error => {
        if (!error || !pending.has(id)) return
        pending.delete(id); clearTimeout(timer); reject(Object.assign(new Error('Device disconnected; execution outcome may be unknown'), { statusCode: 503 }))
      })
    })
  }
  const cluster = clusterOptions ? await createRelayCluster({ ...clusterOptions, store, handle: sendLocal }) : null
  const sendRpc = (deviceId, request, principal) => {
    if (cluster) return cluster.send(deviceId, request, principal)
    const connection = devices.get(deviceId)
    if (!connection) return Promise.reject(Object.assign(new Error('The computer is offline'), { statusCode: 503 }))
    return sendLocal(deviceId, connection.connectionId, request, principal)
  }
  const hub = new GatewayEventHub({ sendRpc, ...streaming })
  const heartbeat = setInterval(async () => {
    for (const [deviceId, connection] of devices) {
      try {
        const session = await store.get(`identity-session:${connection.identitySessionId}`)
        if (!session || session.expires <= Date.now() || cluster && !await cluster.owns(deviceId, connection.connectionId) || !connection.alive) { connection.socket.terminate(); continue }
        connection.alive = false; connection.socket.ping()
      } catch { connection.socket.terminate() }
    }
  }, 5000)
  heartbeat.unref?.()
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers.origin && req.headers.origin !== origin) return reply.code(403).send({ error: 'Origin denied' })
    if (req.headers.host !== new URL(origin).host) return reply.code(403).send({ error: 'Host denied' })
  })
  const { authenticate, audit, revoke } = registerIdentity({ app, store, config, origin, issuer, organization, dev, rolesClaim, adminRole, scopes, auditRetentionDays, auditMaxRecords, onRevoke: sessionId => {
    for (const connection of devices.values()) if (connection.identitySessionId === sessionId) connection.socket.close(1008, 'Login session revoked')
    hub.closeIdentitySession(sessionId)
  } })
  registerDeviceLifecycle({ app, store, authenticate, audit, revoke, onUnbind: async deviceId => {
    await store.delete(`route:${deviceId}`)
    devices.get(deviceId)?.socket.close(1008, 'Device unbound')
    hub.closeDevice(deviceId)
    for (const [id, job] of pending) if (job.deviceId === deviceId) { pending.delete(id); clearTimeout(job.timer); job.reject(Object.assign(new Error('Device unbound'), { statusCode: 410 })) }
  } })
  registerSshProfiles({ app, store, authenticate, audit })
  app.get('/api/v1/devices', async req => {
    const { account } = await authenticate(req)
    return Promise.all((await store.list('device:')).filter(d => d.organization === account.organization && (d.owner === account.id || Object.keys(d.shares?.[account.id] || {}).length)).map(async ({ key, shares, ...device }) => ({ ...device, shared: device.owner !== account.id, ...(device.owner !== account.id ? { permissions: shares[account.id] } : {}), online: cluster ? await cluster.online(device.id) : devices.has(device.id) })))
  })
  app.post('/api/v1/devices/:id/share', async req => {
    const { account } = await authenticate(req), device = await store.get(`device:${req.params.id}`)
    if (!device || device.owner !== account.id || device.organization !== account.organization) throw Object.assign(new Error('Owner access required'), { statusCode: 403 })
    const { accountId, sessionId, role } = req.body || {}
    const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value)
    if (!safeId(accountId) || !safeId(sessionId) || !['view', 'control', 'remove'].includes(role)) throw Object.assign(new Error('Valid accountId, sessionId and role required'), { statusCode: 400 })
    const member = await store.get(`account:${accountId}`)
    if (!member || member.disabled || member.organization !== account.organization) throw Object.assign(new Error('Recipient must be an active member of this organization'), { statusCode: 403 })
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await store.get(`device:${device.id}`)
      if (!current || current.owner !== account.id || await store.get(`device-unbound:${device.id}`)) throw Object.assign(new Error('Device binding changed'), { statusCode: 409 })
      const next = structuredClone(current)
      next.shares ||= {}; next.shares[accountId] ||= {}
      if (role === 'remove') delete next.shares[accountId][sessionId]
      else next.shares[accountId][sessionId] = role
      if (await store.comparePut(`device:${device.id}`, current, next)) { await audit('share', account.id, device.id); hub.revalidate(device.id); return { saved: true } }
    }
    throw Object.assign(new Error('Sharing changed concurrently; retry'), { statusCode: 409 })
  })
  app.get('/relay/device', { websocket: true }, (socket, req) => {
      const authentication = authenticate(req, 'device')
      authentication.catch(() => socket.close(1008, 'Login required'))
      let deviceId, connectionId
      const registrationDeadline = setTimeout(() => { if (!deviceId) socket.close(1008, 'Registration timed out') }, 15000)
      registrationDeadline.unref?.()
      socket.on('message', async raw => {
        try {
          const auth = await authentication
          const message = JSON.parse(raw.toString())
          if (message.type === 'register') {
            if (!/^[a-zA-Z0-9_-]{1,128}$/.test(message.device?.id)) throw new Error('Invalid device id')
            if (await store.get(`device-unbound:${message.device.id}`)) throw new Error('Device has been unbound; bind a new local identity')
            if (deviceId && deviceId !== message.device.id) throw new Error('This connection is already bound')
            const binding = await store.get(`identity-session:${auth.sessionId}`)
            if (!binding || binding.deviceId && binding.deviceId !== message.device.id) throw new Error('Credential belongs to a different device')
            if (!binding.deviceId && !await store.comparePut(`identity-session:${auth.sessionId}`, binding, { ...binding, deviceId: message.device.id })) throw new Error('Device binding changed')
            const previous = await store.get(`device:${message.device.id}`)
            if (previous && (previous.owner !== auth.account.id || previous.organization !== auth.account.organization)) throw new Error('Device already bound')
            deviceId = message.device.id
            clearTimeout(registrationDeadline)
            devices.get(deviceId)?.socket.close(1000, 'Replaced by device reconnect')
            connectionId = randomUUID()
            const features = Array.isArray(message.features) ? message.features.filter(feature => typeof feature === 'string' && /^[\w.-]{1,32}$/.test(feature)).slice(0, 16) : []
            devices.set(deviceId, { socket, connectionId, alive: true, account: auth.account, identitySessionId: auth.sessionId, features })
            await store.put(`device:${deviceId}`, { id: deviceId, name: String(message.device.name).slice(0, 100), owner: auth.account.id, organization, shares: previous?.shares || {} })
            if (await store.get(`device-unbound:${deviceId}`)) { await store.delete(`device:${deviceId}`); throw new Error('Device was unbound during registration') }
            await cluster?.claim(deviceId, connectionId)
            if (await store.get(`device-unbound:${deviceId}`) || !await store.get(`identity-session:${auth.sessionId}`)) { await cluster?.release(deviceId, connectionId); throw new Error('Device login was revoked during registration') }
            socket.send(JSON.stringify({ type: 'registered', deviceId }))
            hub.deviceRegistered(deviceId, features.includes(RELAY_FEATURE_EVENT_PUSH))
          } else if (message.type === 'response') {
            const job = pending.get(message.id)
            if (job?.deviceId === deviceId && job.socket === socket) { pending.delete(message.id); clearTimeout(job.timer); job.resolve(message) }
          } else if (message.type === 'event' || message.type === 'device-event') {
            // Live uplink for SSE fanout. Rows stay replayable from the device
            // journal, so malformed/oversized frames are simply ignored.
            if (deviceId && devices.get(deviceId)?.socket === socket && raw.byteLength <= 1024 * 1024) {
              if (message.type === 'event' && isJournalRow(message.event)) hub.publish(deviceId, message.event)
              if (message.type === 'device-event' && isDeviceEvent(message.event)) hub.publishDeviceEvent(deviceId, message.event)
            }
          }
        } catch { socket.close(1008, 'Invalid relay message') }
      })
      socket.on('pong', () => { const connection = devices.get(deviceId); if (connection?.socket === socket) connection.alive = true })
      socket.on('close', () => {
        clearTimeout(registrationDeadline)
        if (devices.get(deviceId)?.socket === socket) { devices.delete(deviceId); hub.deviceClosed(deviceId) }
        void cluster?.release(deviceId, connectionId).catch(() => {})
        for (const [id, job] of pending) if (job.socket === socket) {
          pending.delete(id); clearTimeout(job.timer)
          job.reject(Object.assign(new Error('Device disconnected; execution outcome may be unknown'), { statusCode: 503 }))
        }
      })
      void authentication.then(auth => {
        const timer = setTimeout(() => socket.close(1008, 'Authentication expired'), Math.max(1, auth.expires - Date.now()))
        socket.on('close', () => clearTimeout(timer))
      }).catch(() => {})
  })
  app.post('/api/v1/devices/:id/rpc', async (req, reply) => {
    const identity = await authenticate(req), { account } = identity, device = await store.get(`device:${req.params.id}`)
    const request = validateRequest(req.body), owner = device?.owner === account.id && device.organization === account.organization
    const grants = device?.organization === account.organization ? device.shares?.[account.id] || {} : {}
    const access = Object.hasOwn(grants, request.params?.sessionId || '') ? grants[request.params.sessionId] : undefined
    const sharedIndex = ['status', 'sessions.list', 'commands.list'].includes(request.method) && Object.keys(grants).length > 0
    if (!device || (!owner && !access && !sharedIndex)) return reply.code(403).send({ error: { code: 'forbidden', message: 'Device access denied' } })
    if (!owner && !sharedIndex) {
      const allowed = access === 'control' ? ['sessions.get', 'media.preview', 'events.list', 'control.acquire', 'control.release', 'turns.start', 'turns.cancel', 'approvals.resolve'] : ['sessions.get', 'media.preview', 'events.list']
      if (!allowed.includes(request.method)) return reply.code(403).send({ error: { code: 'forbidden', message: 'Operation exceeds shared access' } })
      if (request.method === 'approvals.resolve' && typeof request.params?.answer === 'string' && !['allow_once', 'deny'].includes(request.params.answer)) return reply.code(403).send({ error: { code: 'forbidden', message: 'Shared control cannot create persistent permission grants' } })
      if (request.method === 'turns.start') request.params = { sessionId: request.params.sessionId, prompt: request.params.prompt }
    }
    if (!owner && request.method === 'commands.list') return { result: [] }
    const principal = { id: device.owner, actorId: account.id, client: identity.sessionId, organization }
    const connection = devices.get(device.id)
    if (!cluster && !connection) return reply.code(503).send({ error: { code: 'device_offline', message: 'The computer is offline' } })
    const result = cluster ? await cluster.send(device.id, request, principal) : await sendLocal(device.id, connection.connectionId, request, principal)
    if (await store.get(`device-unbound:${device.id}`)) return reply.code(410).send({ error: { code: 'device_unbound', message: 'Device was unbound while this request was in progress' } })
    if (!owner && !result.error) {
      if (request.method === 'sessions.list') result.result = result.result.filter(session => Object.hasOwn(grants, session.id))
      if (request.method === 'status') result.result = { schemaVersion: '1', device: { id: device.id, name: device.name }, roots: [], shared: true, active: (result.result.active || []).filter(sessionId => Object.hasOwn(grants, sessionId)) }
    }
    await audit(req.body.method, account.id, device.id, result.error ? 'error' : 'ok')
    return result.error ? reply.code(result.status || 400).send({ error: result.error }) : { result: result.result }
  })
  // SSE event streams (docs/remote-sse-contract.md): ?sessionId= gives a
  // replayable per-session stream; no sessionId gives the live device stream.
  app.get('/api/v1/devices/:id/events/stream', async (req, reply) => {
    const identity = await authenticate(req), { account } = identity, device = await store.get(`device:${req.params.id}`)
    const sessionId = typeof req.query?.sessionId === 'string' && req.query.sessionId ? req.query.sessionId : null
    if (sessionId && !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return reply.code(400).send({ error: { code: 'invalid_session', message: 'Invalid session id' } })
    const owner = device?.owner === account.id && device.organization === account.organization
    const grants = device?.organization === account.organization ? device.shares?.[account.id] || {} : {}
    if (!device || (!owner && (sessionId ? !Object.hasOwn(grants, sessionId) : !Object.keys(grants).length))) return reply.code(403).send({ error: { code: 'forbidden', message: 'Device access denied' } })
    const after = streamCursor(req.query?.after, req.headers)
    if (after === null) return reply.code(400).send({ error: { code: 'invalid_cursor', message: 'Event cursor must be a non-negative integer' } })
    if (hub.countForAccount(account.id) >= hub.maxPerAccount || hub.countForDevice(device.id) >= hub.maxPerDevice) return reply.code(429).send({ error: { code: 'stream_limit', message: 'Too many live event subscriptions' } })
    const principal = { id: device.owner, actorId: account.id, client: identity.sessionId, organization }
    const access = async () => {
      // Streams die with the login session too: natural expiry (no revoke) is
      // caught here on every sync tick, matching the device-server expiry timer.
      const [current, session] = await Promise.all([store.get(`device:${device.id}`), store.get(`identity-session:${identity.sessionId}`)])
      if (!session || session.expires <= Date.now()) return null
      if (!current || current.organization !== account.organization || await store.get(`device-unbound:${device.id}`)) return null
      if (current.owner === account.id) return { owner: true, sessions: null }
      const shared = current.shares?.[account.id] || {}
      if (!Object.keys(shared).length || (sessionId && !Object.hasOwn(shared, sessionId))) return null
      return { owner: false, sessions: new Set(Object.keys(shared)) }
    }
    if (!await access()) return reply.code(410).send({ error: { code: 'device_unbound', message: 'Device was unbound' } })
    if (sessionId) {
      // Probe once before hijacking so an offline device fails the handshake
      // with the same JSON error events.list polling would produce.
      try { await sendRpc(device.id, { id: randomUUID(), method: 'events.list', params: { sessionId, after } }, principal) }
      catch (error) {
        if ([429, 502, 503, 504].includes(error.statusCode)) return reply.code(503).send({ error: { code: 'device_offline', message: 'The computer is offline' } })
        throw error
      }
    }
    await audit('events.stream', account.id, device.id)
    const writer = new SseWriter(reply)
    const sub = sessionId
      ? hub.addSessionStream({ deviceId: device.id, sessionId, after, principal, writer, access, accountId: account.id, identitySessionId: identity.sessionId })
      : hub.addDeviceStream({ deviceId: device.id, principal, writer, access, accountId: account.id, identitySessionId: identity.sessionId, grants: owner ? null : new Set(Object.keys(grants)) })
    reply.raw.on('close', () => hub.remove(sub))
  })
  app.get('/health', { config: { rateLimit: false } }, async (_req, reply) => {
    try { await store.get('health:probe'); return { ok: true, version: PACKAGE_VERSION } }
    catch { return reply.code(503).send({ ok: false, version: PACKAGE_VERSION }) }
  })
  await app.register(staticFiles, { root: fileURLToPath(new URL('../web/', import.meta.url)) })
  app.addHook('onClose', async () => { clearInterval(heartbeat); hub.close(); for (const d of devices.values()) d.socket.close(); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error('Gateway is restarting'), { statusCode: 503 })) }; pending.clear(); await cluster?.close(); await store.close() })
  // SSE streams are hijacked long-lived responses: Fastify waits for in-flight
  // connections before it runs onClose hooks, so end the streams first.
  const baseClose = app.close.bind(app)
  app.close = async () => { hub.close(); await baseClose() }
  app.setErrorHandler((error, req, reply) => reply.code(error.status || error.statusCode || 500).send({ error: { code: error.code || 'gateway_error', message: error.status || error.statusCode ? error.message : 'Gateway request failed' } }))
  return app
}
