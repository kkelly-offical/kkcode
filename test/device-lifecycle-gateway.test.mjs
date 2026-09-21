import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import WebSocket from 'ws'
import { createGateway } from '../src/remote/gateway.mjs'
import { MemoryStore } from '../src/remote/store.mjs'
import { identityHash } from '../src/remote/identity.mjs'

test('real gateway unbind closes relay, removes shares, revokes refresh grants and permanently rejects old device UUID', { timeout: 15000 }, async () => {
  const store = new MemoryStore(), sockets = []
  const owner = { id: 'owner', organization: 'QA', name: 'Owner' }, viewer = { id: 'viewer', organization: 'QA', name: 'Viewer' }
  for (const account of [owner, viewer]) await store.put(`account:${account.id}`, account)
  for (const [id, kind, account] of [['browser', 'client', owner], ['viewer', 'client', viewer], ['device', 'device', owner], ['fresh', 'device', owner]]) {
    await store.put(`identity-session:${id}`, { id, kind, accountId: account.id, deviceId: null, expires: Date.now() + 60000 })
    await store.put(`token:${identityHash(`fixture-${id}`)}`, { sessionId: id, kind, account, expires: Date.now() + 60000 })
    await store.put(`refresh:${identityHash(`fixture-refresh-${id}`)}`, { sessionId: id, expires: Date.now() + 60000 })
  }
  const app = await createGateway({ origin: 'http://localhost', issuer: 'https://idp.invalid', clientId: 'fixture', dev: true, oidcConfig: {}, store, organization: 'QA' })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const request = (url, token, payload) => app.inject({ method: payload === undefined ? 'GET' : 'POST', url, headers: { host: 'localhost', authorization: `Bearer fixture-${token}` }, ...(payload === undefined ? {} : { payload }) })
  const connect = async token => {
    const socket = new WebSocket(address.replace('http:', 'ws:') + '/relay/device', { headers: { host: 'localhost', authorization: `Bearer fixture-${token}` } })
    sockets.push(socket)
    await once(socket, 'open')
    return socket
  }
  try {
    const socket = await connect('device'), registered = once(socket, 'message')
    socket.send(JSON.stringify({ type: 'register', device: { id: 'computer', name: 'Computer' } }))
    assert.equal(JSON.parse((await registered)[0]).type, 'registered')
    assert.equal((await request('/api/v1/devices/computer/share', 'browser', { accountId: 'viewer', sessionId: 'session-one', role: 'control' })).statusCode, 200)
    assert.equal((await request('/api/v1/devices', 'viewer')).json().length, 1)
    assert.equal((await request('/api/v1/devices/computer/unbind', 'browser', { confirmation: 'computer' })).statusCode, 401)
    const closed = once(socket, 'close')
    const unbound = await request('/api/v1/devices/computer/unbind', 'device', { confirmation: 'computer' })
    assert.equal(unbound.statusCode, 200, unbound.body)
    await closed
    assert.equal((await request('/api/v1/devices', 'browser')).json().length, 0)
    assert.equal((await request('/api/v1/devices', 'viewer')).json().length, 0)
    assert.equal((await request('/api/v1/devices/computer/rpc', 'viewer', { id: 'stale-share', method: 'sessions.get', params: { sessionId: 'session-one' } })).statusCode, 403)
    assert.equal((await request('/auth/refresh', 'device', { refresh_token: 'fixture-refresh-device' })).statusCode, 401)
    assert.equal((await request('/api/v1/profile', 'browser')).statusCode, 200, 'browser login remains independent')
    assert.equal((await request('/api/v1/devices/computer/unbind', 'device', { confirmation: 'computer' })).statusCode, 200, 'only exact revocation receipt remains replayable')
    const oldId = await connect('fresh'), denied = once(oldId, 'close')
    oldId.send(JSON.stringify({ type: 'register', device: { id: 'computer', name: 'Old computer' } }))
    assert.equal((await denied)[0], 1008, 'fresh credentials cannot resurrect retired identity')
    assert.equal((await store.get('identity-session:fresh')).deviceId, null)
    const newId = await connect('fresh'), rebound = once(newId, 'message')
    newId.send(JSON.stringify({ type: 'register', device: { id: 'new-computer', name: 'New computer' } }))
    assert.equal(JSON.parse((await rebound)[0]).type, 'registered')
    assert.deepEqual((await store.get('device:new-computer')).shares, {})
    assert.equal((await request('/api/v1/devices', 'viewer')).json().length, 0)
  } finally { for (const socket of sockets) socket.terminate(); await app.close() }
})
