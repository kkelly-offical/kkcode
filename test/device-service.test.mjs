import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DeviceService } from '../src/device/service.mjs'
import { createDeviceServer } from '../src/device/server.mjs'
import { resolveDevicePath } from '../src/device/files.mjs'
import { saveCheckpoint, loadCheckpoint, cleanupCheckpoints, listCheckpoints } from '../src/kernel/session/checkpoint.mjs'
import WebSocket from 'ws'
import { once } from 'node:events'

test('device authentication, request deduplication, leases and origin protection', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kkcode-device-test-'))
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = path.join(home, '.kkcode')
  const service = await new DeviceService({ cwd: home, roots: [home] }).initialize()
  const server = await createDeviceServer({ service, port: 0, bootstrapToken: 'fixture-bootstrap', pairingCode: '12345678' })
  try {
    const { address } = await server.listen()
    const post = (route, data, headers = {}) => fetch(address + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) })
    assert.equal((await post('/api/v1/rpc', { id: 'a', method: 'status' })).status, 401)
    assert.equal((await post('/api/v1/auth/pair', { code: 'wrong' })).status, 401)
    const pairing = await post('/api/v1/auth/pair', { bootstrap: 'fixture-bootstrap', native: true })
    assert.equal(pairing.status, 200)
    const headers = { Authorization: `Bearer ${(await pairing.json()).token}` }
    assert.equal((await post('/api/v1/auth/pair', { bootstrap: 'fixture-bootstrap' })).status, 401)
    assert.equal((await post('/api/v1/rpc', { id: 'status', method: 'status' }, { ...headers, Origin: 'https://evil.example' })).status, 403)
    const first = { id: 'lease1', method: 'control.acquire', params: { sessionId: 'test' } }
    const a = await (await post('/api/v1/rpc', first, headers)).json(), b = await (await post('/api/v1/rpc', first, headers)).json()
    assert.deepEqual(a, b)
    assert.equal((await post('/api/v1/rpc', { ...first, params: { sessionId: 'different' } }, headers)).status, 409)
    await assert.rejects(service.request({ id: 'lease2', method: 'control.acquire', params: { sessionId: 'test' } }, { id: 'local', client: 'another' }), /Another client/)
    await assert.rejects(service.request({ id: 'intruder', method: 'status' }, { id: 'another', client: 'another' }), /owner/)
    await mkdir(path.join(home, '.ssh')); await writeFile(path.join(home, '.ssh', 'id_rsa'), 'fixture')
    await assert.rejects(resolveDevicePath(path.join(home, '.ssh', 'id_rsa'), [home]), /protected/)
    await assert.rejects(resolveDevicePath(os.tmpdir(), [home]), /outside/)
  } finally {
    await server.close()
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
test('named Ultra checkpoints survive later normal turns and numeric retention', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kkcode-checkpoints-'))
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = home
  try {
    await saveCheckpoint('session', { name: 'hybrid_stage_1', iteration: 1, stageIndex: 2 })
    for (let i = 2; i <= 12; i++) await saveCheckpoint('session', { iteration: i })
    assert.equal((await loadCheckpoint('session', 'ultra_latest')).stageIndex, 2)
    assert.equal((await loadCheckpoint('session', 'hybrid_stage_1')).stageIndex, 2)
    await cleanupCheckpoints('session', { maxKeep: 2 })
    const remaining = await listCheckpoints('session')
    assert.ok(remaining.includes('cp_12') && remaining.includes('cp_11'))
    assert.ok(!remaining.includes('cp_9'))
    await assert.rejects(saveCheckpoint('../outside', { iteration: 1 }), /invalid/)
  } finally {
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('logout closes an authenticated event socket and private custom state cannot be browsed', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kkcode-event-auth-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(home, 'private-custom-state')
  const service = await new DeviceService({ cwd: home, roots: [home] }).initialize()
  const server = await createDeviceServer({ service, port: 0, bootstrapToken: 'fixture-events' })
  let socket
  try {
    const { address } = await server.listen()
    const paired = await fetch(address + '/api/v1/auth/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bootstrap: 'fixture-events', native: true }) })
    const token = (await paired.json()).token
    socket = new WebSocket(address.replace(/^http/, 'ws') + '/api/v1/events', { headers: { Authorization: `Bearer ${token}` } })
    await once(socket, 'open')
    const closed = once(socket, 'close')
    const logout = await fetch(address + '/api/v1/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' })
    assert.equal(logout.status, 200); assert.equal((await closed)[0], 1008)
    await service.record({ type: 'stream.text.delta', sessionId: 'events', payload: { text: 'after logout' } })
    await assert.rejects(resolveDevicePath(path.join(process.env.KKCODE_HOME, 'device', 'identity.json'), [home]), error => error.status === 403)
    await assert.rejects(resolveDevicePath(process.env.KKCODE_HOME, [process.env.KKCODE_HOME], { directory: true }), error => error.status === 403)
  } finally { socket?.terminate(); await server.close(); if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(home, { recursive: true, force: true }) }
})

test('expired authentication closes existing event streams without waiting for another RPC', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kkcode-event-expiry-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(home, 'state')
  const service = await new DeviceService({ cwd: home, roots: [home] }).initialize()
  const server = await createDeviceServer({ service, port: 0, bootstrapToken: 'fixture-expiry', sessionTtlMs: 200 })
  let socket
  try {
    const { address } = await server.listen()
    const paired = await fetch(address + '/api/v1/auth/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bootstrap: 'fixture-expiry', native: true }) })
    const token = (await paired.json()).token
    socket = new WebSocket(address.replace(/^http/, 'ws') + '/api/v1/events', { headers: { Authorization: `Bearer ${token}` } })
    assert.equal((await once(socket, 'close'))[0], 1008)
  } finally { socket?.terminate(); await server.close(); if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(home, { recursive: true, force: true }) }
})
