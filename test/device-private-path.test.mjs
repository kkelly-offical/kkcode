import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertPublicDeviceComponents } from '../src/device/private-path.mjs'
import { readDeviceFile, resolveNewDevicePath } from '../src/device/files.mjs'

test('Windows credential aliases, alternate streams and special devices fail the lexical guard', () => {
  for (const name of ['.env:secret', '.env::$DATA', 'private.key::$DATA', '.ssh.\\id_rsa', '.env ', '.NPMRC.', 'NUL', 'con.txt', 'COM¹', 'LPT2.log', 'ordinary.txt:secret']) {
    assert.throws(() => assertPublicDeviceComponents(`C:\\work\\${name}`, { platform: 'win32' }), { code: 'path_denied', status: 403 })
  }
  for (const file of ['C:\\work\\README.md', 'D:/projects/src/code.mjs', '\\\\server\\approved\\readme.txt']) {
    assert.doesNotThrow(() => assertPublicDeviceComponents(file, { platform: 'win32' }))
  }
  assert.throws(() => assertPublicDeviceComponents('\\\\server\\.ssh\\id_rsa', { platform: 'win32' }), { code: 'path_denied' })
})

test('POSIX filenames do not acquire Windows-only alias semantics', () => {
  for (const name of ['chapter:one.txt', 'CON', 'public.txt ', '.ssh.']) {
    assert.doesNotThrow(() => assertPublicDeviceComponents(`/work/${name}`, { platform: 'linux' }))
  }
  for (const name of ['.env', '.env.local', '.ssh/id_rsa', 'private.key']) {
    assert.throws(() => assertPublicDeviceComponents(`/work/${name}`, { platform: 'linux' }), { code: 'path_denied' })
  }
})

test('actual NTFS stream aliases cannot preview credentials or become new worktree paths', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-private-stream-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const privateFile = path.join(root, '.env'), publicFile = path.join(root, 'public.txt')
  await writeFile(privateFile, 'private-default-stream-fixture')
  await writeFile(`${privateFile}:secret`, 'private-named-stream-fixture')
  await writeFile(publicFile, 'public')
  // Demonstrate that the aliases exist on this real Windows filesystem; a
  // missing-file error would not be evidence of a working security boundary.
  assert.equal(await readFile(`${privateFile}::$DATA`, 'utf8'), 'private-default-stream-fixture')
  assert.equal(await readFile(`${privateFile}:secret`, 'utf8'), 'private-named-stream-fixture')
  for (const target of [`${privateFile}::$DATA`, `${privateFile}:secret`, `${publicFile}::$DATA`, `${privateFile}.`, `${privateFile} `]) {
    await assert.rejects(readDeviceFile(target, [root]), { code: 'path_denied' })
  }
  await assert.rejects(resolveNewDevicePath(`${publicFile}:workspace`, [root]), { code: 'path_denied' })
  assert.equal((await readDeviceFile(publicFile, [root])).content, 'public')
})
