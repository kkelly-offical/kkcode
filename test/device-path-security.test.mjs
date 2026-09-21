import test from 'node:test'
import assert from 'node:assert/strict'
import { access, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AttachmentStore } from '../src/device/attachments.mjs'
import { ReplayStore } from '../src/device/replay-store.mjs'
import { listDeviceFolder, readDeviceFile, resolveDevicePath } from '../src/device/files.mjs'

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'kkcode-path-security-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  return base
}
async function fileSymlink(t, source, target) {
  try { await symlink(source, target, 'file'); return true } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('This Windows account cannot create file symlinks; mandatory hard-link coverage runs separately'); return false }
    throw error
  }
}

test('out-of-scope existing and nonexistent paths are rejected before resolving user-controlled filesystem locations', async t => {
  const base = await fixture(t), allowed = path.join(base, 'allowed'), outside = path.join(base, 'outside.txt')
  await mkdir(allowed); await writeFile(outside, 'do not expose')
  for (const input of [outside, path.join(base, 'missing', 'nested.txt'), path.join(base, 'allowed-sibling', 'missing.txt'), path.join(allowed, '..', 'outside.txt')]) {
    await assert.rejects(resolveDevicePath(input, [allowed]), { code: 'path_denied', status: 403 })
  }
  for (const input of ['', null, {}, [], 'bad\0name']) await assert.rejects(resolveDevicePath(input, [allowed]), { code: 'invalid_path' })
  await assert.rejects(resolveDevicePath(path.join(allowed, '.ssh', 'missing'), [allowed]), { code: 'path_denied' })
  assert.equal(await readFile(outside, 'utf8'), 'do not expose')
})

test('untrusted UNC paths are denied without a network path-resolution attempt', { timeout: 3000 }, async t => {
  const base = await fixture(t)
  await assert.rejects(resolveDevicePath('\\\\192.0.2.123\\untrusted-share\\missing.txt', [base]), { code: 'path_denied', status: 403 })
})

test('configured directory aliases and canonical paths both work without admitting out-of-root links', async t => {
  const base = await fixture(t), allowed = path.join(base, 'allowed'), alias = path.join(base, 'allowed-alias'), outside = path.join(base, 'outside')
  await mkdir(allowed); await mkdir(outside); await writeFile(path.join(allowed, 'public.txt'), 'allowed')
  await writeFile(path.join(outside, 'private.txt'), 'outside')
  await symlink(allowed, alias, 'junction')
  await symlink(outside, path.join(allowed, 'outside-link'), 'junction')
  assert.equal((await readDeviceFile(path.join(alias, 'public.txt'), [alias])).content, 'allowed')
  assert.equal((await readDeviceFile(path.join(await realpath(allowed), 'public.txt'), [alias])).content, 'allowed')
  await assert.rejects(readDeviceFile(path.join(allowed, 'outside-link', 'private.txt'), [allowed]), { code: 'path_denied' })
  const listed = await listDeviceFolder(alias, [alias])
  assert.deepEqual(listed.entries.map(item => item.name), ['public.txt'])
})

test('case aliases remain usable only for the same allowed directory and cannot expose a custom private-state root', async t => {
  const base = await fixture(t), allowed = path.join(base, 'AllowedRoot'), upper = path.join(base, 'ALLOWEDROOT'), privateRoot = path.join(allowed, 'PrivateState')
  await mkdir(allowed); await mkdir(privateRoot)
  await writeFile(path.join(allowed, 'public.txt'), 'public')
  await writeFile(path.join(privateRoot, 'remote-credentials.json'), 'private fixture sentinel')
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = privateRoot
  try {
    await assert.rejects(readDeviceFile(path.join(privateRoot, 'remote-credentials.json'), [allowed]), { code: 'path_denied' })
    const normal = await stat(allowed, { bigint: true }), alias = await stat(upper, { bigint: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (alias && normal.dev === alias.dev && normal.ino === alias.ino) {
      assert.equal((await readDeviceFile(path.join(upper, 'public.txt'), [allowed])).content, 'public')
      await assert.rejects(readDeviceFile(path.join(upper, 'PRIVATESTATE', 'remote-credentials.json'), [allowed]), { code: 'path_denied' })
    } else {
      await mkdir(upper); await writeFile(path.join(upper, 'public.txt'), 'different case-sensitive directory')
      await assert.rejects(readDeviceFile(path.join(upper, 'public.txt'), [allowed]), { code: 'path_denied' })
    }
    await symlink(privateRoot, path.join(allowed, 'private-alias'), 'junction')
    await assert.rejects(readDeviceFile(path.join(allowed, 'private-alias', 'remote-credentials.json'), [allowed]), { code: 'path_denied' })
  } finally { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous }
})

test('attachment removal accepts only an existing same-session opaque ID, never a caller-selected filesystem path', async t => {
  const base = await fixture(t), directory = path.join(base, 'attachments'), outside = path.join(base, 'outside.json')
  await writeFile(outside, 'preserve this file')
  const store = await new AttachmentStore({ directory }).initialize()
  const item = await store.upload({ sessionId: 'session', name: 'note.txt', mediaType: 'text/plain', data: Buffer.from('attachment').toString('base64') })
  const hostile = ['../outside', '..\\outside', outside, '%2e%2e%2foutside', `${item.id}\n`, `${item.id}\r`, `${item.id}\u2028`, `${item.id}\u2029`, '', null, {}, 42]
  for (const id of hostile) await assert.rejects(store.remove({ sessionId: 'session', id }), { code: 'attachment_missing' })
  await assert.rejects(store.remove({ sessionId: 'other', id: item.id }), { code: 'attachment_missing' })
  assert.equal((await store.list({ sessionId: 'session' })).attachments.length, 1)
  assert.equal(await readFile(outside, 'utf8'), 'preserve this file')
  await store.remove({ sessionId: 'session', id: item.id })
  await assert.rejects(access(path.join(directory, `${item.id}.json`)), { code: 'ENOENT' })
})

test('replay ASCII ID validation rejects traversal, control characters and Unicode separators', async t => {
  const base = await fixture(t), directory = path.join(base, 'replay'), outside = path.join(base, 'outside.json')
  await mkdir(directory); await writeFile(outside, 'outside sentinel')
  const store = await new ReplayStore(directory).initialize()
  for (const id of ['../outside', '..\\outside', outside, '%2e%2e%2foutside', 'safe\n', 'safe\r', 'safe\r\n', 'safe\u2028', 'safe\u2029', 'safe\0', 'a'.repeat(129), '', {}, null]) {
    await assert.rejects(store.read(id), { code: 'invalid_session' })
    await assert.rejects(store.append({ sessionId: id, type: 'test' }), { code: 'invalid_session' })
  }
  assert.equal(await readFile(outside, 'utf8'), 'outside sentinel')
  assert.equal((await store.append({ sessionId: 'safe_123-abc', type: 'test' })).seq, 1)
})

test('replay rejects planted cursor/journal hard links instead of reading external state', async t => {
  const base = await fixture(t), directory = path.join(base, 'replay'), cursor = path.join(base, 'cursor.json'), journal = path.join(base, 'journal.jsonl')
  await mkdir(directory)
  await writeFile(cursor, '{"cursor":777}')
  await writeFile(journal, JSON.stringify({ sessionId: 'journal', seq: 1, timestamp: Date.now(), payload: { text: 'outside content' } }) + '\n')
  const store = await new ReplayStore(directory).initialize()
  await link(cursor, store.meta('cursor')); await link(journal, store.file('journal'))
  await assert.rejects(store.read('cursor'), { code: 'replay_storage' })
  await assert.rejects(store.read('journal'), { code: 'replay_storage' })
  assert.equal(await readFile(cursor, 'utf8'), '{"cursor":777}')
})

test('cached replay append cannot modify an external file through a swapped hard link', async t => {
  const base = await fixture(t), directory = path.join(base, 'replay'), outside = path.join(base, 'outside.txt')
  await mkdir(directory); await writeFile(outside, 'must remain unchanged')
  const store = await new ReplayStore(directory).initialize()
  await store.append({ sessionId: 'session', type: 'initial' })
  await rm(store.file('session')); await link(outside, store.file('session'))
  await assert.rejects(store.append({ sessionId: 'session', type: 'must-not-escape' }), { code: 'replay_storage' })
  assert.equal(await readFile(outside, 'utf8'), 'must remain unchanged')
})

test('replay rejects planted symlinks and a cached append cannot follow a swapped symlink', async t => {
  const base = await fixture(t), directory = path.join(base, 'replay'), outside = path.join(base, 'outside.txt'), cursor = path.join(base, 'cursor.json')
  await mkdir(directory); await writeFile(outside, 'must remain unchanged'); await writeFile(cursor, '{"cursor":777}')
  const store = await new ReplayStore(directory).initialize()
  if (!await fileSymlink(t, cursor, store.meta('linked'))) return
  await assert.rejects(store.read('linked'), { code: 'replay_storage' })
  await store.append({ sessionId: 'session', type: 'initial' })
  await rm(store.file('session')); await symlink(outside, store.file('session'), 'file')
  await assert.rejects(store.append({ sessionId: 'session', type: 'must-not-escape' }), { code: 'replay_storage' })
  assert.equal(await readFile(outside, 'utf8'), 'must remain unchanged')
})
