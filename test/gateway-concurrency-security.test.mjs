import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import { Readable } from 'node:stream'
import WebSocket from 'ws'
import { createGateway } from '../src/remote/gateway.mjs'
import { MemoryStore } from '../src/remote/store.mjs'
import { identityHash } from '../src/remote/identity.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { resolve, promise } }
async function fixture(run, streaming = {}) {
  const store = new MemoryStore(), owner = { id: 'owner', organization: 'QA' }, viewer = { id: 'viewer', organization: 'QA' }
  for (const account of [owner, viewer]) await store.put(`account:${account.id}`, account)
  for (const [id, kind, account] of [['browser', 'client', owner], ['device', 'device', owner], ['viewer', 'client', viewer]]) {
    await store.put(`identity-session:${id}`, { id, kind, accountId: account.id, deviceId: kind === 'device' ? 'computer' : null, expires: Date.now() + 60000 })
    await store.put(`token:${identityHash(id)}`, { sessionId: id, kind, account, expires: Date.now() + 60000 })
  }
  await store.put('device:computer', { id: 'computer', name: 'Computer', owner: 'owner', organization: 'QA', shares: { viewer: { one: 'view' } } })
  const app = await createGateway({ origin: 'http://localhost', issuer: 'https://idp.invalid', oidcConfig: {}, store, dev: true, organization: 'QA', streaming })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const request = (url, token, payload) => app.inject({ method: payload === undefined ? 'GET' : 'POST', url, headers: { host: 'localhost', authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload }) })
  try { await run({ store, app, address, request }) } finally { await app.close() }
}

test('unbind racing a paused registration cannot resurrect device metadata or acknowledge the retired identity', { timeout: 10000 }, () => fixture(async ({ store, address, request }) => {
  const entered = deferred(), resume = deferred(), originalPut = store.put.bind(store), originalComparePut = store.comparePut.bind(store)
  let paused = true
  const pause = async value => {
    if (!paused || value?.name !== 'Racing registration') return
    paused = false; entered.resolve(); await resume.promise
  }
  store.put = async (key, value) => { if (key === 'device:computer') await pause(value); return originalPut(key, value) }
  store.comparePut = async (key, expected, value) => { if (key === 'device:computer') await pause(value); return originalComparePut(key, expected, value) }
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

test('registration resumes after a concurrent share revocation without restoring the stale grant', { timeout: 10000 }, () => fixture(async ({ store, address, request }) => {
  const entered = deferred(), resume = deferred(), originalPut = store.put.bind(store), originalComparePut = store.comparePut.bind(store)
  let paused = true, writes = 0
  const pause = async value => {
    if (value?.name !== 'Paused registration') return
    writes++
    if (!paused) return
    paused = false; entered.resolve(); await resume.promise
  }
  store.put = async (key, value) => { if (key === 'device:computer') await pause(value); return originalPut(key, value) }
  store.comparePut = async (key, expected, value) => { if (key === 'device:computer') await pause(value); return originalComparePut(key, expected, value) }
  const socket = new WebSocket(address.replace('http:', 'ws:') + '/relay/device', { headers: { Host: 'localhost', Authorization: 'Bearer device' } })
  try {
    await once(socket, 'open')
    const registered = once(socket, 'message')
    socket.send(JSON.stringify({ type: 'register', device: { id: 'computer', name: 'Paused registration' } }))
    await entered.promise
    assert.equal((await request('/api/v1/devices/computer/share', 'browser', { accountId: 'viewer', sessionId: 'one', role: 'remove' })).statusCode, 200)
    resume.resolve()
    const [acknowledgement] = await registered
    assert.equal(JSON.parse(acknowledgement).type, 'registered')
    const saved = await store.get('device:computer')
    assert.equal(Object.hasOwn(saved.shares.viewer || {}, 'one'), false, 'registration must merge shares from the latest record')
    assert.ok(writes >= 2, 'the stale compare-and-set must be retried after rereading')
    assert.deepEqual((await request('/api/v1/devices', 'viewer')).json(), [])
    assert.equal((await request('/api/v1/devices/computer/rpc', 'viewer', { id: 'revoked-share', method: 'sessions.get', params: { sessionId: 'one' } })).statusCode, 403)
  } finally { resume.resolve(); socket.terminate() }
}))

async function assertConcurrentStreamLimit({ store, address }) {
  const entered = deferred(), resume = deferred(), originalPut = store.put.bind(store)
  let arrivals = 0, gating = true
  store.put = async (key, value) => {
    if (gating && key.startsWith('audit:') && value.action === 'events.stream') {
      arrivals++
      if (arrivals === 2) entered.resolve()
      await resume.promise
    }
    return originalPut(key, value)
  }
  const open = () => new Promise((resolve, reject) => {
    const request = http.get(`${address}/api/v1/devices/computer/events/stream`, { headers: { host: 'localhost', authorization: 'Bearer browser' } }, incoming => {
      resolve(new Response(Readable.toWeb(incoming), { status: incoming.statusCode }))
    })
    request.on('error', reject)
  })
  const requests = [open(), open()], opened = []
  let responses
  try {
    await entered.promise
    gating = false
    resume.resolve()
    responses = await Promise.all(requests)
    opened.push(...responses)
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 429])
    const accepted = responses.find(response => response.status === 200)
    const rejected = responses.find(response => response.status === 429)
    assert.equal((await rejected.json()).error.code, 'stream_limit')
    await accepted.body.cancel()

    let reopened
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = await open()
      opened.push(candidate)
      if (candidate.status === 200) { reopened = candidate; break }
      await candidate.body.cancel()
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(reopened, 'closing the accepted stream releases its quota slot')
    await reopened.body.cancel()
  } finally {
    gating = false
    resume.resolve()
    store.put = originalPut
    if (!responses) opened.push(...(await Promise.allSettled(requests)).flatMap(result => result.status === 'fulfilled' ? [result.value] : []))
    await Promise.all(opened.filter(response => response.status === 200).map(response => response.body.cancel().catch(() => {})))
  }
}

test('two racing event streams cannot exceed the per-account quota', { timeout: 10000 }, () => fixture(assertConcurrentStreamLimit, { maxPerAccount: 1, maxPerDevice: 2 }))

test('two racing event streams cannot exceed the per-device quota', { timeout: 10000 }, () => fixture(assertConcurrentStreamLimit, { maxPerAccount: 2, maxPerDevice: 1 }))

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

test('shared RPC responses recheck revoked grants and identity while the device response is in flight', { timeout: 15000 }, () => fixture(async ({ store, address, request }) => {
  const socket = new WebSocket(address.replace('http:', 'ws:') + '/relay/device', { headers: { Host: 'localhost', Authorization: 'Bearer device' } })
  const gates = new Map()
  try {
    await once(socket, 'open')
    const registered = once(socket, 'message')
    socket.send(JSON.stringify({ type: 'register', device: { id: 'computer', name: 'Computer' } }))
    await registered
    socket.on('message', async raw => {
      const message = JSON.parse(raw)
      if (message.type !== 'request') return
      const gate = gates.get(message.request.id)
      if (gate) { gate.entered.resolve(); await gate.release.promise }
      const result = {
        'events.list': { events: [{ id: 'PRIVATE-EVENT' }] },
        'media.preview': { data: 'PRIVATE-MEDIA', mediaType: 'image/png' },
        'sessions.list': [{ id: 'one', title: 'PRIVATE-ONE' }, { id: 'two', title: 'VISIBLE-TWO' }],
        status: { features: ['artifacts.v1', 'private.feature'], active: ['one', 'two'] }
      }[message.request.method]
      socket.send(JSON.stringify({ type: 'response', id: message.id, result }))
    })
    const call = (token, id, method, params = {}) => request('/api/v1/devices/computer/rpc', token, { id, method, params })
    const pause = async (token, id, method, params) => {
      const gate = deferred(); gate.entered = deferred(); gate.release = deferred()
      gates.set(id, gate)
      const waiting = call(token, id, method, params)
      await gate.entered.promise
      return { waiting, gate }
    }
    const setShares = async shares => {
      const device = await store.get('device:computer')
      await store.put('device:computer', { ...device, shares: { viewer: shares } })
    }
    for (const { method, params, filtered } of [
      { method: 'events.list', params: { sessionId: 'one' } },
      { method: 'media.preview', params: { sessionId: 'one', messageId: 'message', index: 0 } },
      { method: 'sessions.list', params: {}, filtered: true },
      { method: 'status', params: {}, filtered: true }
    ]) {
      const requestId = `partial-${method.replaceAll('.', '-')}`
      await setShares({ one: 'view', two: 'view' })
      const { waiting, gate } = await pause('viewer', requestId, method, params)
      await setShares({ two: 'view' })
      gate.release.resolve()
      const response = await waiting
      if (!filtered) {
        assert.equal(response.statusCode, 403, `${method} must not return a revoked session response`)
        assert.equal(JSON.stringify(response.json()).includes('PRIVATE'), false)
      } else {
        assert.equal(response.statusCode, 200, response.body)
        if (method === 'sessions.list') assert.deepEqual(response.json().result.map(session => session.id), ['two'])
        else assert.deepEqual(response.json().result.active, ['two'])
        assert.equal(JSON.stringify(response.json()).includes('PRIVATE-ONE'), false)
      }
      gates.delete(requestId)
    }
    for (const method of ['sessions.list', 'status']) {
      const requestId = `all-${method.replaceAll('.', '-')}`
      await setShares({ one: 'view', two: 'view' })
      const { waiting, gate } = await pause('viewer', requestId, method)
      await setShares({})
      gate.release.resolve()
      assert.equal((await waiting).statusCode, 403, `${method} must be denied after the final grant is revoked`)
      gates.delete(requestId)
    }
    await setShares({ one: 'view' })
    const disabled = await pause('viewer', 'disabled-events', 'events.list', { sessionId: 'one' })
    const viewer = await store.get('account:viewer')
    await store.put('account:viewer', { ...viewer, disabled: true })
    disabled.gate.release.resolve()
    assert.equal((await disabled.waiting).statusCode, 403, 'response-time authentication must reject a disabled member')
    gates.delete('disabled-events')

    const owner = await pause('browser', 'owner-status', 'status')
    await setShares({})
    owner.gate.release.resolve()
    const ownerResponse = await owner.waiting
    assert.equal(ownerResponse.statusCode, 200, ownerResponse.body)
    assert.deepEqual(ownerResponse.json().result.active, ['one', 'two'], 'owner responses remain unfiltered')
    gates.delete('owner-status')
  } finally {
    for (const gate of gates.values()) gate.release.resolve()
    socket.terminate()
  }
}))
