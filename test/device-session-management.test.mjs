import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { DeviceService } from '../src/device/service.mjs'
import { appendMessage, appendPart, flushNow, getSession } from '../src/kernel/session/store.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-session-actions-')), cwd = path.join(root, 'work'), privateRoot = path.join(root, 'private')
  await mkdir(cwd)
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = privateRoot
  const service = await new DeviceService({ cwd, roots: [cwd] }).initialize()
  t.after(async () => { await service.close(); if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  const principal = { id: 'local', client: 'test' }
  const session = await service.dispatch('sessions.create', { cwd }, principal)
  return { service, principal, id: session.id, privateRoot, cwd }
}

test('session rename/archive/restore is persisted and exposed to every client', async t => {
  const { service, principal, id } = await fixture(t)
  const updated = await service.dispatch('sessions.update', { sessionId: id, title: '新的标题', expectedTitleRevision: 0 }, principal)
  assert.equal(updated.title, '新的标题'); assert.equal(updated.titleSource, 'manual')
  await assert.rejects(service.dispatch('sessions.update', { sessionId: id, title: '过期改名', expectedTitleRevision: 0 }, principal), { code: 'session_changed' })
  for (const title of ['', 'bad\ntitle', 'x'.repeat(121)]) await assert.rejects(service.dispatch('sessions.update', { sessionId: id, title }, principal), { code: 'invalid_title' })
  await service.dispatch('sessions.update', { sessionId: id, archived: true }, principal)
  assert.equal((await service.dispatch('sessions.list', {}, principal)).find(item => item.id === id).archived, true)
  await service.dispatch('control.acquire', { sessionId: id }, principal)
  await assert.rejects(service.dispatch('turns.start', { sessionId: id, prompt: 'continue' }, principal), { code: 'session_archived' })
  await service.dispatch('sessions.update', { sessionId: id, archived: false }, principal)
  assert.equal((await service.dispatch('sessions.get', { sessionId: id }, principal)).archived, false)
})

test('rewind removes complete user rounds including mixed tool/media messages and creates a private backup', async t => {
  const { service, principal, id, privateRoot } = await fixture(t)
  await appendMessage(id, 'user', 'first', { turnId: 'one' })
  await appendMessage(id, 'assistant', 'first answer', { turnId: 'one' })
  const question = await appendMessage(id, 'user', 'draw a diagram', { turnId: 'two' })
  await appendMessage(id, 'assistant', [{ type: 'tool_use', id: 'read', name: 'read', input: {} }], { turnId: 'two' })
  await appendMessage(id, 'user', [{ type: 'tool_result', tool_use_id: 'read', content: 'SVG' }, { type: 'image', mediaType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') }], { turnId: 'two', synthetic: true })
  await appendPart(id, { type: 'tool-call', turnId: 'one', tool: 'list' })
  await appendPart(id, { type: 'tool-call', turnId: 'two', tool: 'read' })
  await flushNow()
  const before = await getSession(id)
  await service.dispatch('control.acquire', { sessionId: id }, principal)
  await assert.rejects(service.dispatch('sessions.rewind', { sessionId: id }, principal), { code: 'confirmation_required' })
  await assert.rejects(service.dispatch('sessions.rewind', { sessionId: id, confirmed: true, expectedLastMessageId: 'stale' }, principal), { code: 'history_changed' })
  const result = await service.dispatch('sessions.rewind', { sessionId: id, confirmed: true, messageId: question.id, expectedLastMessageId: before.messages.at(-1).id }, principal)
  assert.equal(result.prompt, 'draw a diagram'); assert.equal(result.removed, 3); assert.equal(result.filesChanged, false)
  const after = await getSession(id)
  assert.equal(after.messages.length, 2); assert.equal(after.parts.length, 1); assert.equal(after.parts[0].turnId, 'one')
  const backup = JSON.parse(await readFile(path.join(privateRoot, 'checkpoints', id, 'before-rewind.json'), 'utf8'))
  assert.equal(backup.messages.length, 5)
  const events = await service.readEvents(id, 0)
  assert.ok(events.some(event => event.type === 'session.rewound'))
})

test('running sessions cannot be archived or rewound and another client must acquire control', async t => {
  const { service, principal, id } = await fixture(t)
  await service.dispatch('control.acquire', { sessionId: id }, principal)
  service.turns.set(id, { controller: new AbortController() })
  await assert.rejects(service.dispatch('sessions.update', { sessionId: id, archived: true }, principal), { code: 'turn_busy' })
  await assert.rejects(service.dispatch('sessions.rewind', { sessionId: id, confirmed: true }, principal), { code: 'turn_busy' })
  service.turns.delete(id)
  await assert.rejects(service.dispatch('sessions.rewind', { sessionId: id, confirmed: true }, { id: 'local', client: 'other' }), { code: 'control_required' })
})
