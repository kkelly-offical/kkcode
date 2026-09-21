import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import WebSocket from 'ws'
import { createGateway } from '../src/remote/gateway.mjs'
import { MemoryStore } from '../src/remote/store.mjs'
import { identityHash } from '../src/remote/identity.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { resolve, promise } }
async function fixture(run) {
  const store = new MemoryStore(), owner = { id: 'owner', organization: 'QA' }, viewer = { id: 'viewer', organization: 'QA' }
  for (const account of [owner, viewer]) await store.put(`account:${account.id}`, account)
  for (const [id, kind, account] of [['browser', 'client', owner], ['device', 'device', owner], ['viewer', 'client', viewer]]) {
    await store.put(`identity-session:${id}`, { id, kind, accountId: account.id, deviceId: kind === 'device' ? 'computer' : null, expires: Date.now() + 60000 })
    await store.put(`token:${identityHash(id)}`, { sessionId: id, kind, account, expires: Date.now() + 60000 })
  }
  await store.put('device:computer', { id: 'computer', name: 'Computer', owner: 'owner', organization: 'QA', shares: { viewer: { one: 'view' } } })
  const app = await createGateway({ origin: 'http://localhost', issuer: 'https://idp.invalid', oidcConfig: {}, store, dev: true, organization: 'QA' })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const request = (url, token, payload) => app.inject({ method: payload === undefined ? 'GET' : 'POST', url, headers: { host: 'localhost', authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload }) })
  try { await run({ store, app, address, request }) } finally { await app.close() }
}

test('unbind racing a paused registration cannot resurrect device metadata or acknowledge the retired identity', { timeout: 10000 }, () => fixture(async ({ store, address, request }) => {
  const entered = deferred(), resume = deferred(), original = store.put.bind(store)
  let paused = true
  store.put = async (key, value) => { if (key === 'device:computer' && paused) { paused = false; entered.resolve(); await resume.promise }; return original(key, value) }
  const socket = new WebSocket(address.replace('http:', 'ws:') + '/relay/device', { headers: { Host: 'localhost', Authorization: 'Bearer device' } })
  let acknowledged = false
  socket.on('message', () => { acknowledged = true })
  try {
    await once(socket, 'open')
    const closed = once(socket, 'close')
    socket.send(JSON.stringify({ type: 'register', device: { id: 'computer', name: 'Racing registration' } }))
    await entered.promise
    assert.equal((await request('/api/v1/devices/computer/unbind', 'device', { confirmation: 'computer' })).statusCode, 200)
    resume.resolve(); await closed
    // Registration's second tombstone check must clean the late write.
    for (let attempt = 0; attempt < 50 && await store.get('device:computer'); attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(await store.get('device:computer'), null)
    assert.ok(await store.get('device-unbound:computer'))
    assert.equal(acknowledged, false)
    assert.deepEqual((await request('/api/v1/devices', 'viewer')).json(), [])
  } finally { resume.resolve(); socket.terminate() }
}))

test('unbind racing an authorized sharing CAS cannot re-create the device or retain a grant', { timeout: 10000 }, () => fixture(async ({ store, request }) => {
  const entered = deferred(), resume = deferred(), original = store.comparePut.bind(store)
  let paused = true
  store.comparePut = async (key, expected, value) => { if (key === 'device:computer' && paused) { paused = false; entered.resolve(); await resume.promise }; return original(key, expected, value) }
  const sharing = request('/api/v1/devices/computer/share', 'browser', { accountId: 'viewer', sessionId: 'two', role: 'control' })
  try {
    await entered.promise
    assert.equal((await request('/api/v1/devices/computer/unbind', 'device', { confirmation: 'computer' })).statusCode, 200)
    resume.resolve()
    assert.equal((await sharing).statusCode, 409)
    assert.equal(await store.get('device:computer'), null)
    assert.equal((await request('/api/v1/devices/computer/rpc', 'viewer', { id: 'old-share', method: 'sessions.get', params: { sessionId: 'one' } })).statusCode, 403)
  } finally { resume.resolve() }
}))

test('a nonresponding device cannot accumulate unbounded pending relay requests', { timeout: 10000 }, () => fixture(async ({ address, request }) => {
  const socket = new WebSocket(address.replace('http:', 'ws:') + '/relay/device', { headers: { Host: 'localhost', Authorization: 'Bearer device' } })
  const filled = deferred(); let requests = 0
  try {
    await once(socket, 'open')
    const registered = once(socket, 'message')
    socket.send(JSON.stringify({ type: 'register', device: { id: 'computer', name: 'Slow computer' } }))
    await registered
    socket.on('message', raw => { if (JSON.parse(raw).type === 'request' && ++requests === 64) filled.resolve() })
    const waiting = Array.from({ length: 64 }, (_, index) => request('/api/v1/devices/computer/rpc', 'browser', { id: `slow-${index}`, method: 'status' }))
    await filled.promise
    const overflow = await request('/api/v1/devices/computer/rpc', 'browser', { id: 'overflow', method: 'status' })
    assert.equal(overflow.statusCode, 429)
    socket.terminate()
    assert.ok((await Promise.all(waiting)).every(result => result.statusCode === 503))
  } finally { socket.terminate() }
}))
