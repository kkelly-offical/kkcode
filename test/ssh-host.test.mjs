import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { serveSshHost } from '../src/remote/ssh-host.mjs'
import { requestRemoteControl } from '../src/remote/local-control.mjs'
import { createDeviceServer } from '../src/device/server.mjs'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-ssh-host-'))
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = root
  const service = Object.assign(new EventEmitter(), { turns: new Map(), commandSessions: new Set(), sessionTransitions: new Set(), close: async () => {}, request: async () => ({ ok: true }) })
  const host = await serveSshHost({ service, port: 0, idleMs: 200, hasBackgroundWork: async () => false })
  t.after(async () => { await host.close(); if(previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  return { host, service }
}
test('SSH host keeps active work after transport loss, issues fresh one-shot pairing, then drains', async t => {
  const { host, service } = await fixture(t)
  service.turns.set('running', {})
  const first = await requestRemoteControl(host.control, 'pair')
  const second = await requestRemoteControl(host.control, 'pair')
  assert.notEqual(first.bootstrap, second.bootstrap)
  assert.equal(first.lifetime, 'drain-on-disconnect')
  const headers = { host: `127.0.0.1:${first.port}` }
  const paired = await host.server.app.inject({ method: 'POST', url: '/api/v1/auth/pair', headers, payload: { bootstrap: first.bootstrap, native: true } })
  assert.equal(paired.statusCode, 200)
  assert.equal((await host.server.app.inject({ method: 'POST', url: '/api/v1/auth/pair', headers, payload: { bootstrap: first.bootstrap } })).statusCode, 401)
  await wait(350)
  assert.equal((await requestRemoteControl(host.control, 'status')).ok, true, 'idle clients cannot stop an active turn')
  const resumed = await host.server.app.inject({ method: 'POST', url: '/api/v1/auth/pair', headers, payload: { bootstrap: second.bootstrap, native: true } })
  assert.equal(resumed.statusCode, 200)
  assert.equal((await host.server.app.inject({ method: 'POST', url: '/api/v1/auth/heartbeat', headers })).statusCode, 401)
  assert.equal((await host.server.app.inject({ method: 'POST', url: '/api/v1/auth/heartbeat', headers: { ...headers, authorization: `Bearer ${resumed.json().token}` }, payload: {} })).statusCode, 200)
  service.turns.clear()
  await Promise.race([host.closed, wait(3000).then(() => { throw new Error('SSH host failed to drain') })])
})

test('a failed/closed auxiliary Web listener does not own the foreground Remote kernel', async () => {
  let closes = 0
  const service = Object.assign(new EventEmitter(), { turns: new Map(), close: async () => { closes++ } })
  const server = await createDeviceServer({ service, port: 0, closeService: false })
  await server.listen(); await server.close()
  assert.equal(closes, 0)
  const owned = await createDeviceServer({ service, port: 0 })
  await owned.listen(); await owned.close()
  assert.equal(closes, 1)
})
