import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  connectRelay, loadRemoteCredentials, loginRemote, refreshRemoteCredentials
} from '../src/remote/client.mjs'
import {
  clearModelCatalogMemoryCache, discoverModelsForProvider
} from '../src/kernel/provider/model-catalog.mjs'

async function privateHome(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-legacy-boundaries-'))
  const previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = root
  t.after(async () => {
    clearModelCatalogMemoryCache()
    if (previous === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  })
  return root
}

async function serve(t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

test('device login token metadata cannot replace the discovered gateway origin', { timeout: 15000 }, async t => {
  await privateHome(t)
  let trapHits = 0
  const trap = await serve(t, (_req, res) => { trapHits++; res.end('{}') })
  const owner = await serve(t, (req, res) => {
    req.resume()
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/v1/discovery') res.end('{}')
    else if (req.url === '/auth/device') res.end(JSON.stringify({ user_code: '12345678', device_code: 'fixture-device-code', expires_in: 30, interval: 5 }))
    else if (req.url === '/auth/token') res.end(JSON.stringify({ gateway: trap.origin, url: trap.origin, ownerGateway: trap.origin, access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600, profile: { id: 'fixture-owner', organization: 'test' } }))
    else { res.statusCode = 404; res.end('{}') }
  })
  const credentials = await loginRemote({ gateway: owner.origin, print() {} })
  assert.equal(credentials.gateway, owner.origin)
  assert.equal(credentials.url, undefined)
  assert.equal(credentials.ownerGateway, undefined)
  assert.equal(credentials.token_type, 'Bearer')
  assert.deepEqual(credentials.profile, { id: 'fixture-owner', organization: 'test' })
  assert.equal((await loadRemoteCredentials()).gateway, owner.origin)
  assert.equal(trapHits, 0)
})

test('refresh token metadata cannot change the credential destination on the next refresh', async t => {
  await privateHome(t)
  let trapHits = 0, ownerHits = 0
  const trapBodies = []
  const trap = await serve(t, (req, res) => {
    trapHits++
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk })
    req.on('end', () => { trapBodies.push(body); res.end(JSON.stringify({ expires_in: 3600 })) })
  })
  const owner = await serve(t, (req, res) => {
    ownerHits++
    assert.equal(req.url, '/auth/refresh')
    req.resume()
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ gateway: trap.origin, url: trap.origin, ownerGateway: trap.origin, access_token: 'fixture-new-access', expires_in: 3600 }))
  })
  const initial = { gateway: owner.origin, access_token: 'fixture-access', refresh_token: 'fixture-refresh' }
  const refreshed = await refreshRemoteCredentials(initial)
  await refreshRemoteCredentials(refreshed)
  assert.deepEqual(trapBodies, [])
  assert.equal(refreshed.gateway, owner.origin)
  assert.equal(refreshed.url, undefined)
  assert.equal(refreshed.ownerGateway, undefined)
  assert.equal(refreshed.refresh_token, initial.refresh_token)
  assert.equal((await loadRemoteCredentials()).gateway, owner.origin)
  assert.equal(ownerHits, 2)
  assert.equal(trapHits, 0)
})

test('relay WebSocket does not forward a bearer to an HTTP upgrade redirect trap', { timeout: 10000 }, async t => {
  await privateHome(t)
  let trapHits = 0, ownerBearer
  const trap = await serve(t, (req, res) => { trapHits++; req.resume(); res.end('{}') })
  trap.server.on('upgrade', (_req, socket) => { trapHits++; socket.destroy() })
  const owner = await serve(t, (_req, res) => { res.statusCode = 404; res.end() })
  owner.server.on('upgrade', (req, socket) => {
    ownerBearer = req.headers.authorization
    socket.end(`HTTP/1.1 307 Temporary Redirect\r\nLocation: ${trap.origin}/relay/device\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
  })
  const service = Object.assign(new EventEmitter(), {
    metadata: { id: 'fixture-device', name: 'fixture' },
    async bindOwner() {}, async saveIdentity() {}
  })
  let disconnected
  const closed = new Promise(resolve => { disconnected = resolve })
  const relay = await connectRelay({ service, credentials: {
    gateway: owner.origin, access_token: 'fixture-ws-bearer', expiresAt: Date.now() + 3600000,
    profile: { id: 'fixture-owner', organization: 'test' }
  }, onStatus: status => { if (status === 'disconnected') disconnected() } })
  t.after(() => relay.close())
  await closed
  relay.close()
  assert.equal(ownerBearer, 'Bearer fixture-ws-bearer')
  assert.equal(trapHits, 0)
})

test('untrusted catalog pagination cannot turn an owner-selected local catalog into a cross-origin fetch', async t => {
  await privateHome(t)
  let trapHits = 0
  const trap = await serve(t, (_req, res) => { trapHits++; res.end('{}') })
  const owner = await serve(t, (_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [{ id: 'first-model' }], next_page_url: `${trap.origin}/private` }))
  })
  const provider = { type: 'openai-compatible', base_url: `${owner.origin}/v1` }
  await assert.rejects(discoverModelsForProvider({
    config: { provider: { default: 'fixture', fixture: provider } },
    source: { userRaw: { provider: { fixture: provider } }, projectRaw: {}, envOverlay: {} }
  }), error => error.details?.reason === 'unsafe_redirect')
  assert.equal(trapHits, 0)
})

test('catalog credential scopes survive disk reload without storing credentials or authenticating from cache', async t => {
  const root = await privateHome(t)
  const keyA = `fixture-a-${randomUUID()}`, keyB = `fixture-b-${randomUUID()}`
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  let requests = 0
  global.fetch = async (_url, options) => {
    requests++
    const id = options.headers.Authorization === `Bearer ${keyA}` ? 'tenant-a' : 'tenant-b'
    return new Response(JSON.stringify({ data: [{ id }] }))
  }
  const provider = { type: 'openai-compatible', base_url: 'https://fixture.invalid/v1', api_key: keyA }
  const state = { config: { provider: { default: 'fixture', fixture: provider } }, source: { userRaw: { provider: { fixture: provider } }, projectRaw: {}, envOverlay: {} } }
  assert.equal((await discoverModelsForProvider(state)).models[0].id, 'tenant-a')
  clearModelCatalogMemoryCache()
  provider.api_key = keyB
  assert.equal((await discoverModelsForProvider(state)).models[0].id, 'tenant-b')
  clearModelCatalogMemoryCache()
  provider.api_key = keyA
  assert.equal((await discoverModelsForProvider(state)).source, 'cache')
  assert.equal(requests, 2)
  const raw = await readFile(path.join(root, 'cache', 'models.json'), 'utf8')
  assert.equal(raw.includes(keyA), false)
  assert.equal(raw.includes(keyB), false)
  const cached = JSON.parse(raw)
  assert.equal(Object.keys(cached.entries).length, 2)
  for (const [key, value] of Object.entries(cached.entries)) {
    assert.match(key, /^[a-f0-9]{64}$/)
    assert.deepEqual(Object.keys(value).sort(), ['fetchedAt', 'models'])
  }
  state.config.data_policy = { model_origins: [] }
  await assert.rejects(discoverModelsForProvider(state), error => error.code === 'data_policy_denied')
  assert.equal(requests, 2)
})
