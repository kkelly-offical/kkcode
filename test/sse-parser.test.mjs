import test from "node:test"
import assert from "node:assert/strict"
import { parseSSE } from "../src/provider/sse.mjs"

function makeStream(chunks) {
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]))
      } else {
        controller.close()
      }
    }
  })
}

async function collect(stream, signal) {
  const events = []
  for await (const evt of parseSSE(stream, signal)) {
    events.push(evt)
  }
  return events
}

test("parseSSE: multiple events in single chunk", async () => {
  const stream = makeStream([
    'data: {"a":1}\n\ndata: {"b":2}\n\n'
  ])
  const events = await collect(stream)
  assert.equal(events.length, 2)
  assert.equal(events[0].data, '{"a":1}')
  assert.equal(events[0].event, null)
  assert.equal(events[1].data, '{"b":2}')
})

test("parseSSE: event split across chunks", async () => {
  const stream = makeStream([
    'data: {"sp',
    'lit":true}\n\n'
  ])
  const events = await collect(stream)
  assert.equal(events.length, 1)
  assert.equal(events[0].data, '{"split":true}')
})

test("parseSSE: [DONE] terminates stream", async () => {
  const stream = makeStream([
    'data: {"first":1}\n\ndata: [DONE]\n\ndata: {"never":true}\n\n'
  ])
  const events = await collect(stream)
  assert.equal(events.length, 1)
  assert.equal(events[0].data, '{"first":1}')
})

test("parseSSE: event prefix (Anthropic format)", async () => {
  const stream = makeStream([
    'event: content_block_delta\ndata: {"delta":"hi"}\n\n',
    'event: message_stop\ndata: {}\n\n'
  ])
  const events = await collect(stream)
  assert.equal(events.length, 2)
  assert.equal(events[0].event, "content_block_delta")
  assert.equal(events[0].data, '{"delta":"hi"}')
  assert.equal(events[1].event, "message_stop")
})

test("parseSSE: empty lines and comments are skipped", async () => {
  const stream = makeStream([
    '\n\n: comment\n\ndata: {"ok":1}\n\n'
  ])
  const events = await collect(stream)
  assert.equal(events.length, 1)
  assert.equal(events[0].data, '{"ok":1}')
})

test("parseSSE: flush remaining buffer on stream end", async () => {
  const stream = makeStream([
    'data: {"tail":1}'
  ])
  const events = await collect(stream)
  assert.equal(events.length, 1)
  assert.equal(events[0].data, '{"tail":1}')
})
