import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import staticFiles from '@fastify/static'
import rateLimit from '@fastify/rate-limit'
import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DeviceService } from './service.mjs'
import { DEFAULT_PORT } from '../protocol/index.mjs'
import { ATTACHMENT_RPC_BYTES } from './attachments.mjs'
import { PACKAGE_VERSION } from '../version.mjs'
import { SseWriter, streamCursor } from '../http/sse.mjs'
import { createDeviceEventStream, createSessionEventStream } from './event-stream.mjs'

const digest = value => createHash('sha256').update(String(value || '')).digest()
export async function createDeviceServer({ service, port = DEFAULT_PORT, host = '127.0.0.1', https, publicOrigin, pairingCode, bootstrapToken, sessionTtlMs = 86400000, sseSyncMs = 30000, ...options } = {}) {
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 50 || sessionTtlMs > 86400000) throw new Error('Client session lifetime must be between 50 milliseconds and 24 hours')
  const local = ['127.0.0.1', '::1', 'localhost'].includes(host)
  if (!local && !https && !publicOrigin?.startsWith('https://')) throw new Error('Host mode requires --tls-cert/--tls-key or an HTTPS reverse proxy with --origin')
  const device = service || await new DeviceService(options).initialize()
  const app = Fastify({ logger: false, bodyLimit: ATTACHMENT_RPC_BYTES, https })
  const sessions = new Map()
  const sessionSockets = new Map()
  await app.register(cookie)
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute', keyGenerator: req => {
    const token = req.headers.authorization?.replace(/^Bearer /, '') || req.cookies?.kkcode_session
    const session = sessions.get(digest(token).toString('hex'))
    return session && session.expires > Date.now() ? `client:${session.client}` : `ip:${req.ip}`
  } })
  await app.register(websocket, { options: { maxPayload: ATTACHMENT_RPC_BYTES } })
  const bootstrap = bootstrapToken || randomBytes(32).toString('base64url')
  const code = pairingCode || String(randomInt(10000000, 100000000))
  const expires = Date.now() + 300000
  let bootstrapUsed = false, pairingUsed = false
  let origin = publicOrigin || `${https ? 'https' : 'http'}://${host === '::1' ? '[::1]' : host}:${port}`
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers.origin && req.headers.origin !== origin) return reply.code(403).send({ error: { code: 'origin_denied', message: 'Origin not allowed' } })
    const expectedHost = new URL(origin).host
    if (req.headers.host !== expectedHost) return reply.code(403).send({ error: { code: 'host_denied', message: 'Host not allowed' } })
  })
  function principal(req) {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '')
    const token = bearer || req.cookies.kkcode_session
    const session = sessions.get(digest(token).toString('hex'))
    if (!session || session.expires < Date.now()) throw Object.assign(new Error('Login or pair this client first'), { status: 401, code: 'login_required' })
    return { id: 'local', client: session.client, tokenHash: digest(token).toString('hex'), expires: session.expires }
  }
  app.post('/api/v1/auth/pair', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const tokenMode = typeof req.body?.bootstrap === 'string'
    const candidate = tokenMode ? req.body.bootstrap : req.body?.code
    if (Date.now() > expires || (tokenMode ? bootstrapUsed : pairingUsed) || !timingSafeEqual(digest(candidate), digest(tokenMode ? bootstrap : code))) return reply.code(401).send({ error: { code: 'pairing_denied', message: 'Pairing code invalid or expired; restart to generate a new code' } })
    if (tokenMode) bootstrapUsed = true
    else pairingUsed = true
    const token = randomBytes(32).toString('base64url'), client = randomBytes(16).toString('hex')
    sessions.set(digest(token).toString('hex'), { client, expires: Date.now() + sessionTtlMs })
    reply.setCookie('kkcode_session', token, { httpOnly: true, sameSite: 'strict', secure: origin.startsWith('https:'), path: '/', maxAge: Math.ceil(sessionTtlMs / 1000) })
    return { paired: true, client, ...(req.body?.native === true ? { token } : {}) }
  })
  app.post('/api/v1/auth/logout', async (req, reply) => {
    const key = digest(req.headers.authorization?.replace(/^Bearer /, '') || req.cookies.kkcode_session).toString('hex')
    sessions.delete(key)
    for (const socket of sessionSockets.get(key) || []) socket.close(1008, 'Client signed out')
    sessionSockets.delete(key)
    reply.clearCookie('kkcode_session', { path: '/' }); return { loggedOut: true }
  })
  app.post('/api/v1/rpc', async req => ({ result: await device.request(req.body, principal(req)) }))
  // Replayable SSE event streams (docs/remote-sse-contract.md). Shares the
  // WebSocket per-client subscription cap; logout/expiry closes both kinds.
  app.get('/api/v1/events/stream', async (req, reply) => {
    const user = principal(req)
    const sessionId = typeof req.query?.sessionId === 'string' && req.query.sessionId ? req.query.sessionId : null
    if (sessionId && !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw Object.assign(new Error('Invalid session id'), { status: 400, code: 'invalid_session' })
    const after = streamCursor(req.query?.after, req.headers)
    if (after === null) throw Object.assign(new Error('Event cursor must be a non-negative integer'), { status: 400, code: 'invalid_cursor' })
    const peers = sessionSockets.get(user.tokenHash) || new Set()
    if (peers.size >= 8) throw Object.assign(new Error('Too many live event subscriptions'), { status: 429, code: 'stream_limit' })
    const writer = new SseWriter(reply)
    const stream = sessionId
      ? createSessionEventStream({ service: device, sessionId, after, principal: user, writer, syncMs: sseSyncMs })
      : createDeviceEventStream({ service: device, writer })
    const entry = { sse: true, close: () => stream.close() }
    peers.add(entry); sessionSockets.set(user.tokenHash, peers)
    const expiry = setTimeout(() => stream.close(), Math.max(1, user.expires - Date.now())); expiry.unref?.()
    reply.raw.on('close', () => { clearTimeout(expiry); stream.close(); peers.delete(entry); if (!peers.size) sessionSockets.delete(user.tokenHash) })
  })
  app.get('/api/v1/events', { websocket: true }, (socket, req) => {
    let user
    try { user = principal(req) } catch { socket.close(1008, 'Authentication required'); return }
    const peers = sessionSockets.get(user.tokenHash) || new Set()
    if (peers.size >= 8) { socket.close(1013, 'Too many live event subscriptions'); return }
    peers.add(socket); sessionSockets.set(user.tokenHash, peers)
    const expiry = setTimeout(() => socket.close(1008, 'Login expired'), Math.max(1, user.expires - Date.now())); expiry.unref?.()
    const listener = event => {
      if (socket.readyState !== 1) return
      if (socket.bufferedAmount > 2 * 1024 * 1024) return socket.close(1013, 'Reconnect and replay')
      socket.send(JSON.stringify(event))
    }
    device.on('event', listener)
    device.on('device', listener)
    socket.on('close', () => { clearTimeout(expiry); device.off('event', listener); device.off('device', listener); peers.delete(socket); if (!peers.size) sessionSockets.delete(user.tokenHash) })
    socket.send(JSON.stringify({ type: 'connected', client: user.client, schemaVersion: '1' }))
  })
  app.get('/health', async () => ({ ok: true, version: PACKAGE_VERSION }))
  await app.register(staticFiles, { root: fileURLToPath(new URL('../web/', import.meta.url)), prefix: '/', wildcard: true })
  app.setErrorHandler((error, req, reply) => reply.code(error.status || error.statusCode || 500).send({ error: { code: error.code || 'internal_error', message: error.status || error.statusCode ? error.message : 'The device operation failed; inspect local diagnostics' } }))
  app.addHook('onClose', () => {
    // Hijacked SSE responses are not tracked by the HTTP server or the
    // WebSocket plugin; close them or app.close() would wait on them forever.
    for (const peers of sessionSockets.values()) for (const peer of peers) if (peer.sse) peer.close()
    sessionSockets.clear()
    return device.close()
  })
  return {
    app, device, pairingCode: code,
    async listen() {
      const address = await app.listen({ port, host })
      if (!publicOrigin && port === 0) origin = address
      return { address, url: `${origin}/#bootstrap=${bootstrap}`, pairingCode: code }
    },
    close: async () => {
      // SSE responses are hijacked long-lived streams: end them first, or the
      // HTTP server close below would wait on them forever.
      for (const peers of sessionSockets.values()) for (const peer of peers) if (peer.sse) peer.close()
      await app.close()
    }
  }
}
