import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { BrowserNetwork } from '../src/kernel/browser/network.mjs'

for (const transport of ['http', 'websocket']) test(`Browser ${transport} cannot dispatch an old target after policy is revoked during DNS`, async t => {
  let received = 0
  const server = http.createServer((_request, response) => { received++; response.end('must not arrive') })
  server.on('upgrade', (_request, socket) => { received++; socket.destroy() })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://race.example.test:${server.address().port}`
  let hold = false, release, started
  const ready = new Promise(resolve => { started = resolve })
  const network = new BrowserNetwork({ lookup: async () => {
    if (hold) { started(); await new Promise(resolve => { release = resolve }) }
    return [{ address: '127.0.0.1', family: 4 }]
  } })
  t.after(async () => { release?.(); network.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  network.setDataPolicy({ web_origins: [origin] })
  await network.target(origin, true)
  hold = true
  const operation = transport === 'http' ? network.fetch(origin)
    : network.websocket(origin.replace('http:', 'ws:'), { origin })
  // Attach rejection handling before revocation can abort the pending action.
  const rejected = assert.rejects(operation, /policy|策略|abort|cancel/i)
  await ready
  network.setDataPolicy({ web_origins: [] })
  release()
  await rejected
  assert.equal(received, 0, 'the revoked origin must receive neither request bodies nor WebSocket handshakes')
})
