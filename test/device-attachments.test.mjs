import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AttachmentStore, ATTACHMENT_LIMITS } from '../src/device/attachments.mjs'
import { wavBlock, mp4Block } from './helpers/media-fixtures.mjs'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2lGkAAAAASUVORK5CYII='
const upload = (text, sessionId = 'session') => ({ sessionId, name: 'notes.txt', mediaType: 'text/plain', data: Buffer.from(text).toString('base64') })
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kkcode-attachments-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await new AttachmentStore({ directory, ...options }).initialize()
  return { store, directory }
}

test('remote audio/video staging preserves bytes and validates format, quota and session ownership', async t => {
  const { store } = await fixture(t)
  for (const block of [wavBlock, mp4Block]) {
    const item = await store.upload({ sessionId: 'session', name: `${block.type}.bin`, mediaType: block.mediaType, data: block.data })
    const resolved = await store.resolve({ sessionId: 'session', ids: [item.id], prompt: 'describe' })
    assert.deepEqual(resolved.contentBlocks.at(-1), block)
    await resolved.release()
    await assert.rejects(store.resolve({ sessionId: 'other', ids: [item.id], prompt: 'x' }), { code: 'attachment_missing' })
  }
  await assert.rejects(store.upload({ sessionId: 'session', name: 'bad.wav', mediaType: 'audio/wav', data: mp4Block.data }), { code: 'attachment_type' })
  await assert.rejects(store.upload({ sessionId: 'session', name: 'huge.wav', mediaType: 'audio/wav', data: Buffer.alloc(ATTACHMENT_LIMITS.mediaBytes + 1).toString('base64') }), { code: 'attachment_size' })
})

test('uploads are opaque private files; text and real image blocks reach the kernel contract', async t => {
  const { store, directory } = await fixture(t)
  const text = await store.upload(upload('hello\n世界'))
  const image = await store.upload({ sessionId: 'session', name: 'photo.png', mediaType: 'image/png', data: png })
  assert.match(text.id, /^[0-9a-f-]{36}$/)
  assert.equal(text.size, Buffer.byteLength('hello\n世界'))
  assert.equal(Object.hasOwn(text, 'data'), false)
  assert.equal(Object.hasOwn(text, 'path'), false)
  if (process.platform !== 'win32') assert.equal((await stat(path.join(directory, `${text.id}.json`))).mode & 0o777, 0o600)
  const resolved = await store.resolve({ sessionId: 'session', ids: [text.id, image.id], prompt: 'review both' })
  assert.deepEqual(resolved.contentBlocks, [
    { type: 'text', text: 'review both' }, { type: 'text', text: 'Attached file: notes.txt' },
    { type: 'text', text: 'hello\n世界' }, { type: 'text', text: 'Attached file: photo.png' },
    { type: 'image', data: png, mediaType: 'image/png' }
  ])
  assert.equal((await store.list({ sessionId: 'other' })).attachments.length, 0)
  await assert.rejects(store.resolve({ sessionId: 'other', ids: [text.id], prompt: 'x' }), { code: 'attachment_missing' })
  await assert.rejects(store.remove({ sessionId: 'other', id: text.id }), { code: 'attachment_missing' })
  await assert.rejects(store.remove({ sessionId: 'session', id: text.id }), { code: 'attachment_busy' })
  await resolved.release(); await resolved.release()
  assert.deepEqual(await store.remove({ sessionId: 'session', id: text.id }), { removed: true })
  assert.equal((await readdir(directory)).length, 1)
})

test('unsafe names, credential files, invalid MIME/base64/UTF8 and oversized content fail before writes', async t => {
  const { store, directory } = await fixture(t)
  for (const name of ['../escape', 'C:\\secret.txt', 'x/y', '.', '..', '\u001bescape.txt', '.env', '.env.prod', '.npmrc', 'id_ed25519', 'secret.pem', 'signing.jks', 'credentials.json']) {
    await assert.rejects(store.upload({ ...upload('hello'), name }), error => ['invalid_attachment_name', 'credential_attachment'].includes(error.code))
  }
  for (const fields of [
    { mediaType: 'application/pdf' }, { mediaType: 'image/svg+xml' }, { mediaType: 'image/png' },
    { data: '%%%=' }, { data: 'aGk' }, { data: 'aGk=\n' }, { data: 'Zh==' },
    { data: Buffer.from([0xff]).toString('base64') }, { data: Buffer.from('nul\0').toString('base64') },
    { data: Buffer.alloc(ATTACHMENT_LIMITS.textBytes + 1, 65).toString('base64') }
  ]) await assert.rejects(store.upload({ ...upload('hello'), ...fields }))
  await assert.rejects(store.upload(upload('hello', '../../elsewhere')), { code: 'invalid_session' })
  assert.deepEqual(await readdir(directory), [])
})

test('quotas are serialized across concurrent uploads; per-session and device bounds hold', async t => {
  const { store } = await fixture(t, { limits: { perSessionBytes: 6, deviceBytes: 10, entries: 3 } })
  const results = await Promise.allSettled([store.upload(upload('abcd')), store.upload(upload('efgh'))])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  await store.upload(upload('abcde', 'second'))
  await assert.rejects(store.upload(upload('zz', 'third')), { code: 'attachment_quota' })
  await assert.rejects(store.resolve({ sessionId: 'session', ids: Array(9).fill('a'), prompt: 'x' }), { code: 'attachment_ids' })
  const id = (await store.list({ sessionId: 'session' })).attachments[0].id
  await assert.rejects(store.resolve({ sessionId: 'session', ids: [id, id], prompt: 'x' }), { code: 'attachment_ids' })
})

test('unreferenced staging expires; a running turn stays pinned and canonical content remains intact', async t => {
  let now = 1000
  const { store, directory } = await fixture(t, { now: () => now, limits: { retentionMs: 20 } })
  const item = await store.upload(upload('retained content'))
  const resolved = await store.resolve({ sessionId: 'session', ids: [item.id], prompt: 'hello' })
  now += 21
  assert.equal((await store.list({ sessionId: 'session' })).attachments.length, 1)
  await resolved.release()
  assert.equal((await store.list({ sessionId: 'session' })).attachments.length, 0)
  assert.deepEqual(await readdir(directory), [])
  assert.equal(resolved.contentBlocks[2].text, 'retained content')
})

test('staging survives restart, expires on startup, and cannot follow a replaced payload symlink', async t => {
  let now = 100
  const { store, directory } = await fixture(t, { now: () => now, limits: { retentionMs: 50 } })
  const item = await store.upload(upload('stored'))
  const restored = await new AttachmentStore({ directory, now: () => now }).initialize()
  assert.equal((await restored.list({ sessionId: 'session' })).attachments[0].id, item.id)
  const payload = path.join(directory, `${item.id}.json`), original = await readFile(payload)
  await rm(payload)
  const protectedFile = path.join(directory, 'protected.txt'); await writeFile(protectedFile, original)
  try { await symlink(protectedFile, payload) } catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return; throw error }
  await assert.rejects(restored.resolve({ sessionId: 'session', ids: [item.id], prompt: 'x' }))
  await restored.remove({ sessionId: 'session', id: item.id })
  assert.deepEqual(await readFile(protectedFile), original)
  await writeFile(payload, original)
  now += 51
  const expired = await new AttachmentStore({ directory, now: () => now }).initialize()
  assert.equal((await expired.list({ sessionId: 'session' })).attachments.length, 0)
})

test('attachment storage refuses a symlink directory', async t => {
  const { directory } = await fixture(t)
  const real = path.join(directory, 'real'), link = path.join(directory, 'link')
  await mkdir(real)
  try { await symlink(real, link, 'junction') } catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return; throw error }
  await assert.rejects(new AttachmentStore({ directory: link }).initialize(), { code: 'attachment_storage' })
})
