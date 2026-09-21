import test from 'node:test'
import assert from 'node:assert/strict'
import { EventStreamParser, eventsStreamPath, streamSessionEvents } from '../apps/web/src/live.mjs'

test('eventsStreamPath targets the M26 events/stream routes', () => {
  assert.equal(eventsStreamPath({ sessionId: 's1', after: 41 }), '/api/v1/events/stream?sessionId=s1&after=41')
  assert.equal(eventsStreamPath({ gateway: true, deviceId: 'dev/x', sessionId: 's2', after: 0 }), '/api/v1/devices/dev%2Fx/events/stream?sessionId=s2&after=0')
  assert.equal(eventsStreamPath({ sessionId: 's3', after: -5 }), '/api/v1/events/stream?sessionId=s3&after=0')
})

test('EventStreamParser emits complete frames across chunk boundaries', () => {
  const parser = new EventStreamParser()
  assert.deepEqual(parser.push('data: {"seq":1'), [])
  const frames = parser.push('}\n\ndata: {"seq')
  assert.deepEqual(frames, [{ event: 'message', data: '{"seq":1}', id: '' }])
  assert.deepEqual(parser.push('":2}\r\n\r\n: heartbeat\n\n'), [{ event: 'message', data: '{"seq":2}', id: '' }])
  assert.deepEqual(parser.end(), [])
})

test('EventStreamParser keeps event names, ids and multi-line data', () => {
  const parser = new EventStreamParser()
  const frames = parser.push('id: 41\nevent: session.state\ndata: {"running":\ndata: true}\n\nevent: replay.gap\ndata: {}\n\n')
  assert.deepEqual(frames, [
    { event: 'session.state', data: '{"running":\ntrue}', id: '41' },
    { event: 'replay.gap', data: '{}', id: '41' },
  ])
})

const streamOf = (chunks) => new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
    controller.close()
  },
})
const responseOf = ({ status = 200, type = 'text/event-stream', chunks = [] }) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers({ 'content-type': type }),
  body: streamOf(chunks),
})

test('streamSessionEvents dispatches contract v1 frames: connected/state → meta, rows → events', async () => {
  const seen = { events: [], metas: [], gaps: [] }
  const outcome = await streamSessionEvents({
    url: '/api/v1/events/stream?sessionId=s&after=0',
    fetchImpl: async () => responseOf({
      chunks: [
        ': keepalive\n\nretry: 2000\n\n',
        'event: connected\ndata: {"type":"connected","running":true,"approvals":[]}\n\n',
        'id: 1\nevent: stream.text.delta\ndata: {"seq":1,"type":"stream.text.delta"}\n\nda',
        'ta: {"seq":2,"type":"turn.result"}\n\n',
        'event: session.state\ndata: {"type":"session.state","running":false}\n\n',
        'event: replay.gap\ndata: {"type":"replay.gap","earliest":9,"cursor":12}\n\n',
        'event: stream.text.delta\ndata: {"seq":13,"type":"stream.text.delta"}\n\n',
      ],
    }),
    onEvent: (event) => seen.events.push(event),
    onMeta: (meta) => seen.metas.push(meta),
    onGap: (gap) => seen.gaps.push(gap),
  })
  // replay.gap must not close the stream: later rows still arrive.
  assert.equal(outcome, 'closed')
  assert.deepEqual(seen.metas, [
    { type: 'connected', running: true, approvals: [] },
    { type: 'session.state', running: false },
  ])
  assert.deepEqual(seen.events.map((event) => event.seq), [1, 2, 13])
  assert.deepEqual(seen.gaps, [{ type: 'replay.gap', earliest: 9, cursor: 12 }])
})

test('streamSessionEvents rejects non-SSE responses so the caller falls back to polling', async () => {
  for (const response of [responseOf({ status: 404 }), responseOf({ type: 'application/json' })]) {
    await assert.rejects(
      () => streamSessionEvents({ url: '/x', fetchImpl: async () => response }),
      (error) => {
        assert.equal(error.code, 'stream_unavailable')
        return true
      },
    )
  }
})
