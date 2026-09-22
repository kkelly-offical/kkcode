import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createSessionEventStream } from '../src/device/event-stream.mjs'

const turn = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const row = seq => ({ seq, sessionId: 'fixture', type: 'stream.text.delta', payload: { text: String(seq) } })
const state = { running: false, control: null, pendingApprovalCount: 0 }
const envelope = events => ({ events, earliest: 1, cursor: events.at(-1)?.seq || 0, gap: false, ...state, approvals: [] })
function fixture(read) {
  const frames = [], service = new EventEmitter()
  service.sessionState = () => state
  service.sessionEvents = read
  const stream = createSessionEventStream({ service, sessionId: 'fixture', writer: { send(frame) { frames.push(frame); return true }, close() {} } })
  return { frames, service, stream, ids: () => frames.filter(frame => frame.event === 'stream.text.delta').map(frame => frame.id) }
}

test('SSE initial replay does not deliver a queued live copy twice', async t => {
  const gate = deferred()
  const f = fixture(() => gate.promise)
  t.after(() => f.stream.close())
  f.service.emit('event', row(1))
  gate.resolve(envelope([row(1)]))
  await turn()
  assert.deepEqual(f.ids(), ['1'])
  f.service.emit('event', row(2)); await turn()
  assert.deepEqual(f.ids(), ['1', '2'])
})

test('SSE gap replay overtaking queued live rows never rewinds the cursor', async t => {
  const gate = deferred(), started = deferred(); let calls = 0
  const f = fixture(async () => {
    if (++calls === 1) return envelope([row(1)])
    started.resolve(); return gate.promise
  })
  t.after(() => f.stream.close())
  await turn()
  f.service.emit('event', row(3))
  await started.promise
  f.service.emit('event', row(2))
  gate.resolve(envelope([row(2), row(3)]))
  await turn()
  f.service.emit('event', row(4)); await turn()
  assert.deepEqual(f.ids(), ['1', '2', '3', '4'])
  assert.equal(calls, 2, 'no unnecessary resync after a stale live row')
})

test('SSE close discards live callbacks already queued behind replay', async () => {
  const gate = deferred(), f = fixture(() => gate.promise)
  f.service.emit('event', row(1))
  f.stream.close(); gate.resolve(envelope([])); await turn()
  assert.deepEqual(f.frames, [])
  assert.equal(f.service.listenerCount('event'), 0)
})
