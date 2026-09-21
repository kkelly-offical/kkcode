import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import net from 'node:net'
import { createLoopbackProxy, originFormPath } from '../scripts/lab-loopback-proxy.mjs'

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
const rawRequest = (port, target, host = 'gateway.example') => new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port }), chunks = []
  socket.setTimeout(3000, () => socket.destroy(new Error('HTTP boundary request timed out')))
  socket.on('connect', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`))
  socket.on('data', chunk => chunks.push(chunk)); socket.on('end', () => resolve(Buffer.concat(chunks).toString())); socket.on('error', reject)
})

test('origin-form parser rejects authority-changing and malformed request targets', () => {
  for (const target of ['/', '/auth/callback?code=opaque-code&state=a%2Fb%3Dc', '/%E4%BD%A0?next=https%3A%2F%2Fexample.test', '/%2F%2Fencoded.example/path']) assert.equal(originFormPath(target), target)
  for (const target of [undefined, null, '', 'http://attacker.test/', 'https://attacker.test/', '//attacker.test/', '///attacker.test/', '/\\attacker.test/', '/safe\\path', '*', 'attacker.test:443', '/a b', '/a\tb', '/a\r\nb', '/#fragment', '/bad%', '/bad%2', '/bad%xy', '/%00', '/%0d%0a', '/%7f', '/%ff', '/%C0%AF', '/未编码']) assert.throws(() => originFormPath(target), TypeError, String(target))
  for (const port of [0, 65536, -1, NaN, '8080']) assert.throws(() => createLoopbackProxy(port), TypeError)
})

test('real HTTP boundary never connects to an absolute/network-path attacker target', { timeout: 10000 }, async () => {
  const received = [], trapped = []
  const backend = createServer((req, res) => { received.push(req.url); res.end('fixed backend') })
  const trap = createServer((req, res) => { trapped.push(req.url); res.end('attacker') })
  const backendPort = await listen(backend), trapPort = await listen(trap)
  const proxy = createServer(createLoopbackProxy(backendPort)), proxyPort = await listen(proxy)
  try {
    for (const target of [`http://127.0.0.1:${trapPort}/stolen`, `//127.0.0.1:${trapPort}/stolen`, `///127.0.0.1:${trapPort}/stolen`, `/\\127.0.0.1:${trapPort}/stolen`, 'http://user:password@127.0.0.1/stolen', '/bad%', '/bad%xy', '/%0d%0aHost:evil', '/#fragment']) {
      const response = await rawRequest(proxyPort, target)
      assert.match(response, /^HTTP\/1\.1 400 /, target)
    }
    assert.deepEqual(received, [], 'rejected targets must not reach even the allowed backend')
    assert.deepEqual(trapped, [], 'no attacker-controlled authority can receive a request')
    const encoded = await rawRequest(proxyPort, '/%2F%2Fencoded.example/resource?url=http%3A%2F%2Fevil', `127.0.0.1:${trapPort}`)
    assert.match(encoded, /^HTTP\/1\.1 200 /)
    assert.deepEqual(received, ['/%2F%2Fencoded.example/resource?url=http%3A%2F%2Fevil'])
    assert.deepEqual(trapped, [], 'even an incoming Host header cannot change the socket destination')
  } finally { await close(proxy); await close(backend); await close(trap) }
})

test('fixed backend receives ordinary callback queries, method, headers and body unchanged', { timeout: 10000 }, async () => {
  let observed
  const backend = createServer((req, res) => {
    const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      observed = { method: req.method, path: req.url, host: req.headers.host, marker: req.headers['x-lab-marker'], body: Buffer.concat(chunks).toString() }
      res.writeHead(201, { 'x-backend': 'fixed' }); res.end('completed')
    })
  })
  const backendPort = await listen(backend), proxy = createServer(createLoopbackProxy(backendPort)), port = await listen(proxy)
  try {
    const response = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/auth/callback?code=opaque%2Fcode&state=a%3Db', method: 'POST', headers: { Host: 'gateway.example', 'Content-Type': 'application/json', 'x-lab-marker': 'fixture' } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, header: res.headers['x-backend'], body: Buffer.concat(chunks).toString() }))
      })
      req.on('error', reject); req.end('{"browser":true}')
    })
    assert.deepEqual(response, { status: 201, header: 'fixed', body: 'completed' })
    assert.deepEqual(observed, { method: 'POST', path: '/auth/callback?code=opaque%2Fcode&state=a%3Db', host: 'gateway.example', marker: 'fixture', body: '{"browser":true}' })
  } finally { await close(proxy); await close(backend) }
})
