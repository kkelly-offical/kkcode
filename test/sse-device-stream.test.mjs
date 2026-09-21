import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DeviceService } from '../src/device/service.mjs'
import { createDeviceServer } from '../src/device/server.mjs'

/** Minimal SSE reader over a fetch response: collects parsed frames. */
class SseClient {
  constructor(response) {
    this.response = response
    this.reader = response.body.getReader()
    this.buffer = ''
    this.frames = []
    this.waiters = []
    this.done = false
    this.pump = this.read()
  }
  async read() {
    try {
      while (true) {
        const { done, value } = await this.reader.read()
        if (done) break
        this.buffer += Buffer.from(value).toString('utf8')
        let index
        while ((index = this.buffer.indexOf('\n\n')) >= 0) {
          const raw = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 2)
          const frame = {}
          for (const line of raw.split('\n')) {
            if (line.startsWith(':')) continue
            const colon = line.indexOf(':')
            if (colon < 0) continue
            const field = line.slice(0, colon), value = line.slice(colon + 1).replace(/^ /, '')
            if (field === 'data') frame.data = frame.data === undefined ? value : `${frame.data}\n${value}`
            else frame[field] = value
          }
          if (frame.data === undefined) continue
          try { frame.json = JSON.parse(frame.data) } catch { /* non-JSON frame */ }
          this.frames.push(frame)
          this.wake()
        }
      }
    } catch { /* server closed the socket */ }
    this.done = true
    this.wake()
  }
  wake() { const waiters = this.waiters.splice(0); for (const resolve of waiters) resolve() }
  /** Next frame matching predicate, or null when the stream ends/times out. */
  async next(predicate = () => true, timeoutMs = 3000) {
    const start = this.frames.findIndex(predicate)
    if (start >= 0) return this.frames.splice(0, start + 1).pop()
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), timeoutMs)
      const check = () => {
        const index = this.frames.findIndex(predicate)
        if (index >= 0) { clearTimeout(timer); resolve(this.frames.splice(0, index + 1).pop()); return }
        if (this.done) { clearTimeout(timer); resolve(null); return }
        this.waiters.push(check)
      }
      this.waiters.push(check)
    })
  }
  close() { return this.response.body.cancel().catch(() => {}) }
}

async function fixture(t, { retention, sseSyncMs = 50 } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kkcode-sse-device-'))
  const previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(home, 'state')
  const service = await new DeviceService({ cwd: home, roots: [home], retention }).initialize()
  const server = await createDeviceServer({ service, port: 0, bootstrapToken: 'fixture-sse', sseSyncMs })
  const { address } = await server.listen()
  const paired = await fetch(`${address}/api/v1/auth/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bootstrap: 'fixture-sse', native: true }) })
  const { token } = await paired.json()
  t.after(async () => {
    await server.close()
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(home, { recursive: true, force: true })
  })
  const open = (query = '', headers = {}) => fetch(`${address}/api/v1/events/stream${query}`, { headers: { Authorization: `Bearer ${token}`, ...headers } })
  return { service, server, address, token, open }
}

test('session stream: hello envelope, live rows in seq order, cross-session isolation', async t => {
  const { service, open } = await fixture(t)
  const client = new SseClient(await open('?sessionId=s1'))
  t.after(() => client.close())
  const hello = await client.next(frame => frame.event === 'connected')
  assert.ok(hello, 'connected hello arrives')
  assert.equal(hello.id, '0')
  assert.equal(hello.json.type, 'connected')
  assert.equal(hello.json.sessionId, 's1')
  assert.deepEqual({ running: hello.json.running, control: hello.json.control, pendingApprovalCount: hello.json.pendingApprovalCount }, { running: false, control: null, pendingApprovalCount: 0 })
  await service.record({ type: 'stream.text.delta', sessionId: 's1', turnId: 't1', payload: { text: 'he', step: 1 } })
  await service.record({ type: 'stream.text.delta', sessionId: 'other-session', turnId: 't9', payload: { text: 'stray', step: 1 } })
  await service.record({ type: 'stream.text.delta', sessionId: 's1', turnId: 't1', payload: { text: 'llo', step: 1 } })
  const first = await client.next(frame => frame.event === 'stream.text.delta')
  const second = await client.next(frame => frame.event === 'stream.text.delta')
  assert.equal(first.id, '1'); assert.equal(first.json.payload.text, 'he')
  assert.equal(second.id, '2'); assert.equal(second.json.payload.text, 'llo')
  assert.equal(second.json.schemaVersion, '1')
  // The other session's row must never reach this stream.
  assert.equal(await client.next(() => true, 300), null)
})

test('session stream: session.state follows turn lifecycle and approvals', async t => {
  const { service, open } = await fixture(t)
  const client = new SseClient(await open('?sessionId=s1'))
  t.after(() => client.close())
  await client.next(frame => frame.event === 'connected')
  service.turns.set('s1', { controller: new AbortController(), client: 'local', turnId: 't1' })
  await service.record({ type: 'turn.start', sessionId: 's1', turnId: 't1', payload: { prompt: 'hi' } })
  const running = await client.next(frame => frame.event === 'session.state')
  assert.ok(running, 'session.state emitted on the sync tick')
  assert.equal(running.json.running, true)
  service.turns.delete('s1')
  await service.record({ type: 'turn.result', sessionId: 's1', turnId: 't1', payload: { reply: 'done' } })
  const idle = await client.next(frame => frame.event === 'session.state' && frame.json.running === false)
  assert.ok(idle, 'turn.result triggers an immediate idle session.state')
})

test('session stream: Last-Event-ID and ?after= replay without duplicates; journal rotation signals replay.gap', async t => {
  const { service, open } = await fixture(t, { retention: { replay: { maxEvents: 4, sessionBytes: 65536, totalBytes: 1048576, maxAgeMs: 86400000, maxEventBytes: 65536, maxResponseBytes: 1048576 } } })
  for (const text of ['a', 'b']) await service.record({ type: 'stream.text.delta', sessionId: 's1', turnId: 't1', payload: { text, step: 1 } })
  let client = new SseClient(await open('?sessionId=s1'))
  await client.next(frame => frame.event === 'connected')
  const seen = []
  for (let i = 0; i < 2; i++) seen.push(await client.next(frame => frame.event === 'stream.text.delta'))
  assert.deepEqual(seen.map(frame => [frame.id, frame.json.payload.text]), [['1', 'a'], ['2', 'b']])
  await client.close()
  await service.record({ type: 'stream.text.delta', sessionId: 's1', turnId: 't1', payload: { text: 'c', step: 1 } })
  // Reconnect via Last-Event-ID: only seq 3 replays.
  client = new SseClient(await open('?sessionId=s1', { 'Last-Event-ID': '2' }))
  const replayed = await client.next(frame => frame.event === 'stream.text.delta')
  assert.equal(replayed.id, '3')
  assert.equal(replayed.json.payload.text, 'c')
  assert.equal(await client.next(frame => frame.event === 'stream.text.delta', 300), null)
  await client.close()
  // Rotate the journal past the cursor: rows 4–6 evict 1–2 (maxEvents 4).
  for (const text of ['d', 'e', 'f']) await service.record({ type: 'stream.text.delta', sessionId: 's1', turnId: 't1', payload: { text, step: 1 } })
  client = new SseClient(await open('?sessionId=s1&after=0'))
  const gap = await client.next(frame => frame.event === 'replay.gap')
  assert.ok(gap, 'replay.gap is signalled on the same stream')
  assert.equal(gap.json.type, 'replay.gap')
  assert.ok(gap.json.earliest >= 3)
  const tail = await client.next(frame => frame.event === 'stream.text.delta')
  assert.equal(tail.id, String(gap.json.earliest))
  await client.close()
})

test('device stream: snapshot hello, session.status from turn rows, device-scope events', async t => {
  const { service, open } = await fixture(t)
  const client = new SseClient(await open())
  t.after(() => client.close())
  const hello = await client.next(frame => frame.event === 'connected')
  assert.equal(hello.json.type, 'connected')
  assert.equal(hello.json.deviceId, service.metadata.id)
  assert.equal(hello.json.online, true)
  assert.deepEqual(hello.json.active, [])
  service.turns.set('s1', { controller: new AbortController(), client: 'local', turnId: 't1' })
  await service.record({ type: 'turn.start', sessionId: 's1', turnId: 't1', payload: { prompt: 'secret prompt must not leak' } })
  const started = await client.next(frame => frame.event === 'session.status')
  assert.deepEqual({ sessionId: started.json.sessionId, running: started.json.running }, { sessionId: 's1', running: true })
  assert.equal(JSON.stringify(started.json).includes('secret prompt'), false, 'device stream carries no prompt content')
  service.turns.delete('s1')
  await service.record({ type: 'turn.result', sessionId: 's1', turnId: 't1', payload: { reply: 'ok' } })
  const stopped = await client.next(frame => frame.event === 'session.status' && frame.json.running === false)
  assert.ok(stopped)
  service.emitDeviceEvent('models.updated', { provider: 'default', source: 'network', models: [{ id: 'm1', origin: 'auto' }] })
  const models = await client.next(frame => frame.event === 'models.updated')
  assert.equal(models.json.provider, 'default', 'device events are flat on the wire, matching the contract doc')
  assert.equal(models.json.deviceId, service.metadata.id)
  assert.equal(models.json.models[0].origin, 'auto')
})

test('stream auth, validation, per-client cap and logout close', async t => {
  const { address, token, open } = await fixture(t)
  assert.equal((await fetch(`${address}/api/v1/events/stream?sessionId=s1`)).status, 401)
  assert.equal((await open('?sessionId=bad id')).status, 400)
  assert.equal((await open('?sessionId=s1&after=-1')).status, 400)
  const clients = []
  t.after(() => Promise.all(clients.map(client => client.close())))
  for (let i = 0; i < 8; i++) {
    const response = await open(`?sessionId=cap${i}`)
    assert.equal(response.status, 200)
    clients.push(new SseClient(response))
  }
  assert.equal((await open('?sessionId=overflow')).status, 429)
  // Logout closes every live stream for this client.
  const closed = clients[0].next(() => true, 3000)
  await fetch(`${address}/api/v1/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' })
  await closed
  for (const client of clients) await Promise.race([client.pump, new Promise(resolve => setTimeout(resolve, 3000))])
  assert.ok(clients.every(client => client.done), 'all streams end after logout')
})
