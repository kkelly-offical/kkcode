import Fastify from 'fastify'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'

const MAX_BYTES = 12 * 1024 * 1024
const failure = (message, statusCode = 503) => Object.assign(new Error(message), { statusCode })

/** Cross-node traffic is authenticated and encrypted, never written to the database.
 * Only route metadata is durable. Configure this listener on a private network.
 */
export async function createRelayCluster({ store, address, host = '127.0.0.1', port = 18274, secret, nodeId = randomUUID(), leaseMs = 15000, handle }) {
  if (!/^[a-f0-9]{64}$/i.test(secret || '')) throw new Error('HA requires a shared 32-byte hexadecimal cluster secret')
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(nodeId) || !Number.isSafeInteger(leaseMs) || leaseMs < 300 || leaseMs > 300000) throw new Error('Invalid HA node identity or lease duration')
  const url = new URL(address)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Cluster address must be an HTTP(S) origin')
  const key = Buffer.from(secret, 'hex'), routes = new Map(), seen = new Map()
  let closed = false, renewing = false, renewal = Promise.resolve(), forwarding = 0, forwardingBytes = 0
  function seal(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([cipher.update(JSON.stringify({ nonce: randomUUID(), at: Date.now(), ...value })), cipher.final()])
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') }
  }
  function open(envelope) {
    if (!envelope || typeof envelope.body !== 'string' || envelope.body.length > MAX_BYTES) throw failure('Invalid cluster envelope', 403)
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv || '', 'base64'))
    decipher.setAuthTag(Buffer.from(envelope.tag || '', 'base64'))
    const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.body, 'base64')), decipher.final()]).toString())
    if (!Number.isFinite(value.at) || Math.abs(Date.now() - value.at) > 60000 || typeof value.nonce !== 'string' || seen.has(value.nonce)) throw failure('Expired or replayed cluster envelope', 403)
    for (const [nonce, expires] of seen) if (expires < Date.now()) seen.delete(nonce)
    if (seen.size >= 10000) throw failure('Cluster replay cache is full', 429)
    seen.set(value.nonce, Date.now() + 60000)
    return value
  }
  const app = Fastify({ logger: false, bodyLimit: MAX_BYTES })
  app.post('/rpc', async (request, reply) => {
    let message
    try { message = open(request.body) } catch { return reply.code(403).send({ error: 'Cluster authentication failed' }) }
    if (message.target !== nodeId) return reply.code(409).send({ error: 'Route changed' })
    const route = await store.get(`route:${message.deviceId}`)
    if (!route || route.nodeId !== nodeId || route.connectionId !== message.connectionId || route.expires <= Date.now()) return reply.code(503).send({ error: 'Device route expired' })
    try { return seal({ requestNonce: message.nonce, response: await handle(message.deviceId, message.connectionId, message.request, message.principal) }) }
    catch (error) { return seal({ requestNonce: message.nonce, error: { message: error.statusCode ? error.message : 'Device relay failed', statusCode: error.statusCode || 503 } }) }
  })
  app.setErrorHandler((_error, _request, reply) => reply.code(503).send({ error: 'Cluster request failed' }))
  await app.listen({ host, port })
  async function release(deviceId, connectionId) {
    const route = routes.get(deviceId)
    if (!route || route.connectionId !== connectionId) return
    routes.delete(deviceId)
    await store.compareDelete(`route:${deviceId}`, route)
  }
  const interval = setInterval(() => {
    if (renewing || closed) return
    renewing = true
    renewal = (async () => {
      try {
        for (const [deviceId, route] of routes) {
          const next = { ...route, expires: Date.now() + leaseMs }
          const changed = await store.comparePut(`route:${deviceId}`, route, next)
          // A close/reconnect may happen while the database operation is in flight.
          if (routes.get(deviceId) !== route) { if (changed) await store.compareDelete(`route:${deviceId}`, next); continue }
          if (changed) routes.set(deviceId, next)
          else routes.delete(deviceId)
        }
      } catch { /* Failed renewal expires the lease: fail closed rather than serving stale routes. */ }
      finally { renewing = false }
    })()
  }, Math.max(100, Math.floor(leaseMs / 3)))
  interval.unref?.()
  return {
    nodeId,
    async claim(deviceId, connectionId) {
      const route = { nodeId, address: url.origin, connectionId, expires: Date.now() + leaseMs }
      await store.put(`route:${deviceId}`, route)
      routes.set(deviceId, route)
    },
    release,
    async online(deviceId) { const route = await store.get(`route:${deviceId}`); return !!route && route.expires > Date.now() },
    async owns(deviceId, connectionId) { const route = await store.get(`route:${deviceId}`); return route?.nodeId === nodeId && route.connectionId === connectionId && route.expires > Date.now() },
    async send(deviceId, request, principal) {
      const route = await store.get(`route:${deviceId}`)
      if (!route || route.expires <= Date.now()) throw failure('The computer is offline')
      if (route.nodeId === nodeId) return handle(deviceId, route.connectionId, request, principal)
      const bytes = Buffer.byteLength(JSON.stringify(request)) + 1024
      if (forwarding >= 128 || forwardingBytes + bytes > 64 * 1024 * 1024) throw failure('Gateway forwarding is busy; retry with the same request ID', 429)
      forwarding++; forwardingBytes += bytes
      try {
      const envelope = seal({ target: route.nodeId, deviceId, connectionId: route.connectionId, request, principal })
      const requestNonce = open(envelope).nonce
      let response
      try { response = await fetch(`${route.address}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(32000), redirect: 'error' }) }
      catch { throw failure('Gateway node unavailable; execution outcome may be unknown') }
      if (!response.ok) throw failure('Device route is changing; retry with the same request ID')
      const reader = response.body.getReader(), chunks = []; let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break
          size += value.byteLength
          if (size > MAX_BYTES) { await reader.cancel(); throw failure('Cluster response exceeds the allowed size') }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      const value = open(JSON.parse(Buffer.concat(chunks).toString()))
      if (value.requestNonce !== requestNonce) throw failure('Cluster response mismatch')
      if (value.error) throw failure(value.error.message, value.error.statusCode)
      return value.response
      } finally { forwarding--; forwardingBytes -= bytes }
    },
    async close() {
      closed = true; clearInterval(interval); await renewal
      for (const [deviceId, route] of routes) await release(deviceId, route.connectionId)
      await app.close()
    }
  }
}
