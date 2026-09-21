import test from 'node:test'
import assert from 'node:assert/strict'
import { DeviceLiveView } from '../src/device/live-view.mjs'
import { buildTranscript } from '../apps/web/src/transcript.mjs'

function fixture(limits) {
  const view = new DeviceLiveView(limits), journal = [], canonical = { id: 'session', messages: [], parts: [] }
  let sequence = 0
  const record = (type, payload = {}, turnId = 'turn', sessionId = 'session') => view.record({ type, payload, turnId, sessionId, id: `event-${++sequence}` }, async event => { const row = { ...event, seq: journal.length + 1, timestamp: Date.now() }; journal.push(row); return row })
  const snapshot = extra => view.snapshot('session', { readCursor: async () => journal.length, readCanonical: async () => structuredClone(canonical), ...extra })
  return { view, journal, canonical, record, snapshot }
}

test('a final event queued during a stale canonical snapshot is replayed instead of silently skipped', async () => {
  const { view, journal, canonical, record, snapshot } = fixture()
  let release, entered
  const gate = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { entered = resolve })
  const request = snapshot({ readCanonical: async () => { const old = structuredClone(canonical); entered(); await gate; return old } })
  await started
  canonical.messages.push({ id: 'final', role: 'assistant', turnId: 'turn', step: 1, content: 'late final' })
  const finishing = record('turn.finish', { step: 1, reply: 'late final' })
  release(); const state = await request; await finishing
  assert.equal(state.eventCursor, 0)
  const rows = buildTranscript(state, [...state.liveEvents, ...journal.filter(row => row.seq > state.eventCursor)])
  assert.deepEqual(rows.filter(row => row.type === 'assistant').map(row => row.text), ['late final'])
  await view.close()
})

test('midstream snapshot restores thinking and text prefixes; future tail and canonical completion appear once', async () => {
  const { view, journal, canonical, record, snapshot } = fixture()
  canonical.messages.push({ id: 'question', role: 'user', turnId: 'turn', content: 'Question' })
  await record('turn.start', { prompt: 'Question' })
  await record('stream.thinking.start', { step: 1 })
  await record('stream.thinking.delta', { step: 1, text: 'working' })
  await record('stream.text.delta', { step: 1, text: 'prefix ' })
  const state = await snapshot()
  await record('stream.text.delta', { step: 1, text: 'tail' })
  const rows = buildTranscript(state, [...state.liveEvents, ...journal.filter(row => row.seq > state.eventCursor)])
  assert.equal(rows.filter(row => row.type === 'user').length, 1)
  assert.deepEqual(rows.filter(row => row.type === 'assistant').map(row => row.text), ['prefix tail'])
  assert.equal(rows.find(row => row.type === 'thinking').text, 'working')
  canonical.messages.push({ id: 'answer', role: 'assistant', turnId: 'turn', step: 1, content: 'prefix tail' })
  await record('turn.finish', { step: 1, reply: 'prefix tail' })
  const completed = await snapshot()
  assert.deepEqual(buildTranscript(completed, completed.liveEvents).filter(row => row.type === 'assistant').map(row => row.text), ['prefix tail'])
  await view.close()
})

test('same-step auto-continue excludes persisted partial prefix without suppressing its new live continuation', async () => {
  const { view, canonical, record, snapshot } = fixture()
  await record('stream.text.delta', { step: 1, text: 'first partial' })
  await record('stream.end', { step: 1 })
  await record('turn.auto_continue', { step: 1, continueCount: 1 })
  canonical.messages.push({ id: 'partial', role: 'assistant', turnId: 'turn', step: 1, truncated: true, content: 'first partial' })
  await record('stream.text.delta', { step: 1, text: 'continued' })
  const state = await snapshot()
  assert.deepEqual(state.liveEvents.filter(event => event.type === 'stream.text.delta').map(event => event.payload.text), ['continued'])
  assert.deepEqual(buildTranscript(state, state.liveEvents).filter(row => row.type === 'assistant').map(row => row.text), ['first partial', 'continued'])
  await view.close()
})

test('live prefix is independent of compacted replay and failures preserve partial text with an error', async () => {
  const { view, journal, record, snapshot } = fixture()
  await record('stream.text.delta', { step: 1, text: 'already generated' })
  journal.splice(0)
  await record('turn.failed', { error: 'Provider disconnected' }, 'wrapper-turn-id')
  const state = await snapshot()
  assert.equal(state.liveEvents.find(event => event.type === 'stream.text.delta').payload.text, 'already generated')
  assert.equal(state.liveEvents.at(-1).type, 'turn.failed')
  await view.close()
})

test('live text/session/segment memory remains bounded and historical pages exclude live events', async () => {
  const { view, record, snapshot } = fixture({ maxSessionBytes: 2048, maxTotalBytes: 4096, maxSessions: 2, maxSegments: 4 })
  for (let session = 0; session < 5; session++) for (let step = 0; step < 10; step++) await record('stream.text.delta', { step, text: '界'.repeat(3000) }, 'turn', `session-${session}`)
  assert.ok(view.stats().bytes <= 4096); assert.ok(view.stats().sessions <= 2)
  const retained = view.project('session-4', { messages: [] })
  assert.equal(retained.liveTruncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(retained)) < 2048)
  await record('stream.text.delta', { step: 1, text: '\u0000'.repeat(10000) }, 'turn', 'escaped')
  assert.ok(view.sessions.get('escaped').bytes <= 2048, 'JSON escaping is part of the byte budget')
  assert.equal(Object.hasOwn(await snapshot({ includeLive: false }), 'liveEvents'), false)
  await view.close(); assert.equal(view.stats().bytes, 0)
})

test('failed journal append cannot advance live presentation or poison later snapshots', async () => {
  const { view, snapshot } = fixture()
  await assert.rejects(view.record({ type: 'stream.text.delta', sessionId: 'session', turnId: 'turn', payload: { text: 'not committed' } }, async () => { throw new Error('disk full') }), /disk full/)
  assert.deepEqual((await snapshot()).liveEvents, [])
  await view.close()
})
