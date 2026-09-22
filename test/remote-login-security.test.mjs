import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { deviceLoginPath } from '../src/protocol/login-path.mjs'
import { gatewayUrl, requestGateway, discoverRemoteGateway, refreshRemoteCredentials, revokeRemoteDevice } from '../src/remote/client.mjs'
import { DeviceClient } from '../src/sdk/client.mjs'

test('device login navigation is a fixed local path with an eight-digit code, never an arbitrary URL', () => {
  assert.equal(deviceLoginPath('12345678'), '/login?code=12345678')
  for (const code of ['javascript:alert(1)', '//evil.invalid', '12345678\n', '12345678&next=//evil.invalid', '１２３４５６７８', '', 12345678, null]) {
    assert.throws(() => deviceLoginPath(code), /Invalid gateway login code/)
  }
})

test('gateway requests reject unsafe schemes, embedded credentials and alternate-authority paths', () => {
  assert.equal(gatewayUrl('https://10.0.0.2:18472'), 'https://10.0.0.2:18472')
  for (const gateway of ['http://10.0.0.2', 'https://user:password@example.invalid', 'file:///tmp/a', 'javascript:alert(1)']) {
    assert.throws(() => requestGateway(gateway, '/auth/refresh'), /Gateway/)
  }
  for (const route of ['//evil.invalid', '/\\evil.invalid', '/auth/refresh\r\nHost:evil.invalid']) {
    assert.throws(() => requestGateway('https://gateway.invalid', route), /Invalid gateway API path/)
  }
})

test('CLI and SDK credential requests never follow 307/308 redirects or deliver secrets to a trap', async t => {
  let trapHits = 0, status = 307
  const trap = createServer((req, res) => { trapHits++; req.resume(); res.end('{}') })
  await new Promise(resolve => trap.listen(0, '127.0.0.1', resolve))
  const server = createServer((req, res) => { req.resume(); res.writeHead(status, { location: `http://127.0.0.1:${trap.address().port}/trap` }); res.end('{}') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { for (const item of [server, trap]) await new Promise(resolve => { item.closeAllConnections(); item.close(resolve) }) })
  const gateway = `http://127.0.0.1:${server.address().port}`
  const credentials = { gateway, refresh_token: 'fixture-refresh', access_token: 'fixture-access' }
  for (status of [307, 308]) {
    await assert.rejects(requestGateway(gateway, '/auth/token', { method: 'POST', body: '{"device_code":"fixture"}', redirect: 'follow' }), /fetch failed/)
    await assert.rejects(refreshRemoteCredentials(credentials), /fetch failed/)
    await assert.rejects(revokeRemoteDevice({ deviceId: 'fixture-device', credentials }), /fetch failed/)
    const client = new DeviceClient({ url: gateway, token: 'fixture', refreshToken: 'fixture-refresh', retries: 0 })
    await assert.rejects(client.refresh(), /fetch failed/)
    await assert.rejects(client.request('status'), /fetch failed/)
  }
  assert.equal(trapHits, 0)
})

test('public discovery follows bounded canonical-origin redirects without forwarding credentials', async t => {
  const received = []
  const target = createServer((req, res) => { received.push({ path: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ gateway: `http://127.0.0.1:${target.address().port}` })) })
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve))
  let location = `http://127.0.0.1:${target.address().port}/api/v1/discovery`
  const alias = createServer((req, res) => { req.resume(); res.writeHead(308, { location }); res.end() })
  await new Promise(resolve => alias.listen(0, '127.0.0.1', resolve))
  t.after(async () => { for (const item of [alias, target]) await new Promise(resolve => { item.closeAllConnections(); item.close(resolve) }) })
  const url = `http://127.0.0.1:${alias.address().port}`
  assert.equal(await discoverRemoteGateway(url), `http://127.0.0.1:${target.address().port}`)
  assert.deepEqual(received, [{ path: '/api/v1/discovery', authorization: undefined, cookie: undefined }])
  location = 'http://10.0.0.2/api/v1/discovery'
  await assert.rejects(discoverRemoteGateway(url), /Gateway must use HTTPS/)
  location = `${url}/api/v1/discovery`
  await assert.rejects(discoverRemoteGateway(url), /redirect limit/)
})
