import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { randomBytes, randomUUID, createCipheriv } from 'node:crypto'
import { once } from 'node:events'
import WebSocket from 'ws'
import { createGateway } from '../src/remote/gateway.mjs'
import { createRelayCluster } from '../src/remote/cluster.mjs'
import { MemoryStore } from '../src/remote/store.mjs'
import { identityHash } from '../src/remote/identity.mjs'

const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) }) })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('two gateway nodes route transient RPC, fence old connections, revoke credentials and fail over', { timeout: 30000 }, async () => {
  const store = new MemoryStore(), secret = randomBytes(32).toString('hex')
  const account = { id: 'owner', name: 'Owner', organization: 'HA' }
  await store.put('account:owner', account)
  for (const [id, kind] of [['client', 'client'], ['device', 'device']]) {
    await store.put(`identity-session:${id}`, { id, kind, accountId: 'owner', expires: Date.now() + 60000 })
    await store.put(`token:${identityHash(id)}`, { sessionId: id, kind, account, expires: Date.now() + 60000 })
  }
  const create = async () => {
    const port = await freePort()
    const app = await createGateway({ origin: 'http://localhost', issuer: 'https://idp.invalid', oidcConfig: {}, store, dev: true, organization: 'HA', cluster: { address: `http://127.0.0.1:${port}`, port, secret, leaseMs: 1500 } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    return { app, address }
  }
  const a = await create(), b = await create()
  let socket, replacement, c
  const connect = async node => {
    const ws = new WebSocket(node.address.replace('http:', 'ws:') + '/relay/device', { headers: { Host: 'localhost', Authorization: 'Bearer device' } })
    await once(ws, 'open')
    const registered = once(ws, 'message')
    ws.send(JSON.stringify({ type: 'register', device: { id: 'computer', name: 'HA computer' } }))
    assert.equal(JSON.parse((await registered)[0]).type, 'registered')
    ws.on('message', raw => {
      const message = JSON.parse(raw)
      if (message.type === 'request') ws.send(JSON.stringify({ type: 'response', id: message.id, result: { node: node.address, echo: message.request.params?.marker, device: { id: 'computer' } } }))
    })
    return ws
  }
  const rpc = (node, id = 'request', marker = 'private-conversation-do-not-store') => node.app.inject({ method: 'POST', url: '/api/v1/devices/computer/rpc', headers: { host: 'localhost', authorization: 'Bearer client' }, payload: { id, method: 'status', params: { marker } } })
  try {
    socket = await connect(a)
    const result = await rpc(b)
    assert.equal(result.statusCode, 200, result.body)
    assert.equal(result.json().result.node, a.address)
    assert.equal(result.json().result.echo, 'private-conversation-do-not-store')
    assert.equal(JSON.stringify([...store.data]).includes('private-conversation-do-not-store'), false)
    const listing = await b.app.inject({ url: '/api/v1/devices', headers: { host: 'localhost', authorization: 'Bearer client' } })
    assert.equal(listing.json()[0].online, true)
    // Replacement registration fences the old node immediately, not after its heartbeat.
    replacement = await connect(b)
    assert.equal((await rpc(a, 'moved')).json().result.node, b.address)
    socket.close(); await once(socket, 'close')
    assert.equal((await rpc(a, 'old-close-does-not-delete-new-route')).statusCode, 200)
    await a.app.close()
    assert.equal((await rpc(b, 'surviving-node')).statusCode, 200)
    c = await create()
    const unbound = await c.app.inject({ method: 'POST', url: '/api/v1/devices/computer/unbind', headers: { host: 'localhost', authorization: 'Bearer device' }, payload: { confirmation: 'computer' } })
    assert.equal(unbound.statusCode, 200, unbound.body)
    assert.equal(await store.get('route:computer'), null)
    assert.ok(await store.get('device-unbound:computer'))
    assert.equal(await store.get('identity-session:device'), null)
    // ACL fails before forwarding, even though the socket on another node has
    // not yet observed the next heartbeat.
    assert.equal((await rpc(c, 'unbound-other-node')).statusCode, 403)
    assert.equal((await rpc(b, 'revoked')).statusCode, 403)
  } finally {
    socket?.terminate(); replacement?.terminate()
    await a.app.close(); await b.app.close(); await c?.app.close()
  }
})

test('cluster rejects unsigned requests and expires unrenewed routes without persistent payloads', { timeout: 10000 }, async () => {
  const store = new MemoryStore(), port = await freePort(), address = `http://127.0.0.1:${port}`
  const cluster = await createRelayCluster({ store, address, port, secret: randomBytes(32).toString('hex'), leaseMs: 300, handle: async () => ({ result: true }) })
  try {
    assert.equal((await fetch(address + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: cluster.nodeId, request: { method: 'status' } }) })).status, 403)
    await store.put('route:dead', { nodeId: 'dead-node', address, connectionId: 'stale', expires: Date.now() + 20 })
    assert.equal(await cluster.online('dead'), true)
    await wait(30)
    assert.equal(await cluster.online('dead'), false)
    await assert.rejects(cluster.send('dead', {}, {}), /offline/)
  } finally { await cluster.close() }
})

test('cluster authenticated envelopes reject replay, stale timestamps, wrong keys and connection fencing IDs', { timeout: 10000 }, async () => {
  const store = new MemoryStore(), port = await freePort(), address = `http://127.0.0.1:${port}`, secret = randomBytes(32).toString('hex')
  let calls = 0
  const cluster = await createRelayCluster({ store, address, port, secret, handle: async () => { calls++; return { result: true } } })
  const envelope = (extra = {}, key = secret) => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv)
    const body = Buffer.concat([cipher.update(JSON.stringify({ nonce: randomUUID(), at: Date.now(), target: cluster.nodeId, deviceId: 'computer', connectionId: 'connection', request: { method: 'status' }, principal: { id: 'owner' }, ...extra })), cipher.final()])
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') }
  }
  const send = value => fetch(address + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
  try {
    await cluster.claim('computer', 'connection')
    const valid = envelope()
    assert.equal((await send(valid)).status, 200)
    assert.equal((await send(valid)).status, 403)
    assert.equal((await send(envelope({ at: Date.now() - 120000 }))).status, 403)
    assert.equal((await send(envelope({}, randomBytes(32).toString('hex')))).status, 403)
    assert.equal((await send(envelope({ connectionId: 'old-connection' }))).status, 503)
    assert.equal(calls, 1)
  } finally { await cluster.close() }
})

test('encrypted HA forwarding carries upload-sized requests and history-sized responses within bounded envelopes', { timeout: 15000 }, async () => {
  const store = new MemoryStore(), secret = randomBytes(32).toString('hex'), portA = await freePort(), portB = await freePort()
  const upload = Buffer.alloc(4 * 1024 * 1024, 7).toString('base64'), history = 'h'.repeat(4 * 1024 * 1024)
  const a = await createRelayCluster({ store, secret, port: portA, address: `http://127.0.0.1:${portA}`, handle: async () => { throw new Error('Unexpected local dispatch') } })
  const b = await createRelayCluster({ store, secret, port: portB, address: `http://127.0.0.1:${portB}`, handle: async (_device, _connection, request) => { assert.equal(request.params.data, upload); return { result: history } } })
  try {
    await b.claim('computer', 'live')
    const result = await a.send('computer', { id: 'upload', method: 'attachments.upload', params: { data: upload } }, { id: 'owner' })
    assert.equal(result.result, history)
    assert.equal(JSON.stringify(await store.list('')).includes(upload.slice(0, 100)), false)
  } finally { await a.close(); await b.close() }
})

test('cross-node forwarding applies backpressure while another node is nonresponsive', { timeout: 15000 }, async () => {
  const store = new MemoryStore(), secret = randomBytes(32).toString('hex'), portA = await freePort(), portB = await freePort()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const a = await createRelayCluster({ store, secret, port: portA, address: `http://127.0.0.1:${portA}`, handle: async () => ({ result: true }) })
  const b = await createRelayCluster({ store, secret, port: portB, address: `http://127.0.0.1:${portB}`, handle: async () => { await gate; return { result: true } } })
  let requests = []
  try {
    await b.claim('computer', 'live')
    requests = Array.from({ length: 128 }, (_, index) => a.send('computer', { id: `pending-${index}`, method: 'status' }, { id: 'owner' }))
    await assert.rejects(a.send('computer', { id: 'overflow', method: 'status' }, { id: 'owner' }), error => error.statusCode === 429)
    release()
    assert.equal((await Promise.all(requests)).length, 128)
  } finally { release(); await Promise.allSettled(requests); await a.close(); await b.close() }
})
