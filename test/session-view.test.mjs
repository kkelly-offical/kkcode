import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionView, SESSION_VIEW_BYTES } from '../src/device/session-view.mjs'

const msg = (number, content = `message ${number}`) => ({ id: `msg_${number}`, role: 'user', createdAt: number * 10, content })
const base = (messages, parts = []) => ({ session: { id: 'session', title: 'Conversation', cwd: '/workspace', modeId: 'agent', model: 'model', providerType: 'provider' }, messages, parts })
const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); for (const entry of Object.values(value)) freeze(entry) }; return value }

test('message history pages are complete and ordered; tools between messages belong to the earlier page', () => {
  const input = base([msg(1), msg(3)], [{ id: 'part', type: 'tool-result', createdAt: 20, output: 'between messages' }])
  const latest = sessionView(input, { limit: 1 })
  assert.deepEqual(latest.messages.map(item => item.id), ['msg_3']); assert.deepEqual(latest.parts, [])
  assert.equal(latest.historyHasMore, true); assert.equal(latest.nextBefore, 'msg_3')
  const older = sessionView(input, { before: latest.nextBefore, limit: 1 })
  assert.deepEqual(older.messages.map(item => item.id), ['msg_1']); assert.equal(older.parts[0].id, 'part')
  assert.equal(older.historyHasMore, false); assert.equal(older.nextBefore, null)
  assert.throws(() => sessionView(input, { before: 'missing' }), { code: 'invalid_cursor' })
})

test('message-linked parts follow their selected message even when timestamps overlap', () => {
  const input = base([{ ...msg(1), createdAt: 10 }, { ...msg(2), createdAt: 10 }], [
    { id: 'first', messageId: 'msg_1', createdAt: 11 }, { id: 'second', messageId: 'msg_2', createdAt: 11 }
  ])
  assert.deepEqual(sessionView(input, { limit: 1 }).parts.map(item => item.id), ['second'])
  assert.deepEqual(sessionView(input, { before: 'msg_2', limit: 1 }).parts.map(item => item.id), ['first'])
})

test('binary image forms are stripped recursively without changing frozen canonical data', () => {
  const image = Buffer.from('private image fixture bytes').toString('base64')
  const input = freeze(base([msg(1, [
    { type: 'text', text: 'retain this text' }, { type: 'image', mediaType: 'image/png', data: image },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } },
    { type: 'input_image', image_url: `data:image/png;base64,${image}` }
  ])], [{ id: 'tool', createdAt: 11, result: { content: [{ type: 'image', data: image }] } }]))
  const before = JSON.stringify(input), projected = sessionView(input)
  assert.equal(JSON.stringify(projected).includes(image), false)
  assert.equal(projected.messages[0].content[0].text, 'retain this text')
  assert.equal(JSON.stringify(input), before)
  assert.ok(JSON.stringify(projected).includes('[Image attachment: image/png]'))
})

test('only bounded public session metadata is included', () => {
  const input = base([msg(1)])
  Object.assign(input.session, { api_key: 'must-not-project', config: { secret: 'must-not-project' }, title: '界'.repeat(1000), model: 'm'.repeat(1000), parentSessionId: 'parent', forkFrom: 'source', createdAt: 1, updatedAt: 2 })
  const view = sessionView(input)
  assert.equal(Object.hasOwn(view, 'api_key'), false); assert.equal(Object.hasOwn(view, 'config'), false)
  assert.ok(Buffer.byteLength(view.title) <= 512); assert.equal(view.model.length, 200)
  assert.equal(view.parentSessionId, 'parent'); assert.equal(view.forkFrom, 'source')
  assert.equal(view.createdAt, 1); assert.equal(view.updatedAt, 2)
})

test('complete outer responses obey configured byte caps, including multibyte text, parts and metadata', () => {
  const input = base(Array.from({ length: 20 }, (_, index) => msg(index + 1, '界'.repeat(2000))), Array.from({ length: 100 }, (_, index) => ({ id: `part_${index}`, type: 'tool-result', createdAt: 200, output: '界'.repeat(3000) })))
  for (const maxBytes of [1024, 4096, 65536]) {
    const view = sessionView(input, { maxBytes })
    assert.ok(Buffer.byteLength(JSON.stringify(view)) <= maxBytes)
    assert.ok(view.messages.length >= 1)
    assert.equal(view.partsTruncated, true)
  }
  assert.throws(() => sessionView(input, { maxBytes: 32 }), { code: 'invalid_limit' })
})

test('the hard 4MiB response limit cannot be disabled by exported caller options', () => {
  const input = base(Array.from({ length: 20 }, (_, index) => msg(index + 1, 'x'.repeat(600000))))
  const output = sessionView(input, { maxBytes: 20 * 1024 * 1024, limit: 200 })
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= SESSION_VIEW_BYTES)
  assert.ok(output.messages.length < 20)
  assert.equal(output.historyHasMore, true)
})

test('oversized assistant projections preserve turn/step/continuation identity for live-stream deduplication', () => {
  const message = { ...msg(1, '界'.repeat(300000)), role: 'assistant', turnId: 'turn-123', step: 4, truncated: true, continuation: false }
  const output = sessionView(base([message]), { maxBytes: 1024 }).messages[0]
  assert.equal(output.id, message.id); assert.equal(output.role, 'assistant')
  assert.equal(output.turnId, 'turn-123'); assert.equal(output.step, 4)
  assert.equal(output.truncated, true); assert.equal(output.continuation, false)
  assert.equal(output.createdAt, message.createdAt)
})

test('empty history, extreme limits and deeply nested display values remain safe', () => {
  assert.deepEqual(sessionView(base([])).messages, [])
  assert.equal(sessionView(base([])).historyHasMore, false)
  const input = base([msg(1), msg(2), msg(3)])
  assert.equal(sessionView(input, { limit: -1 }).messages.length, 1)
  const nested = {}; nested.loop = nested
  assert.doesNotThrow(() => sessionView(base([msg(1, nested)])))
})
