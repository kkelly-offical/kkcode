import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, readFile, writeFile, chmod, chown, stat, readdir, rm, symlink, link, open} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import path from 'node:path'
import os from 'node:os'
import {atomicWriteFile, replaceInFileTransactional} from '../src/kernel/tool/edit-transaction.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-atomic-metadata-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  return root
}
for (const mode of [0o600, 0o640, 0o755]) test(`atomic overwrite preserves existing ordinary POSIX mode ${mode.toString(8)}`, {skip: process.platform === 'win32'}, async t => {
  const root = await fixture(t), file = path.join(root, 'script.sh')
  await writeFile(file, '#!/bin/sh\nprintf before\n'); await chmod(file, mode)
  const before = await stat(file)
  await atomicWriteFile(file, '#!/bin/sh\nprintf after\n')
  const after = await stat(file)
  assert.equal(after.mode & 0o777, mode)
  assert.equal(after.uid, before.uid); assert.equal(after.gid, before.gid)
  assert.equal(await readFile(file, 'utf8'), '#!/bin/sh\nprintf after\n')
})
test('transactional exact edit preserves executable scripts', {skip: process.platform === 'win32'}, async t => {
  const root = await fixture(t), file = path.join(root, 'verify.sh')
  await writeFile(file, '#!/bin/sh\necho before\n'); await chmod(file, 0o755)
  const result = await replaceInFileTransactional(file, 'echo before', 'echo after')
  assert.equal(result.ok, true); assert.equal((await stat(file)).mode & 0o777, 0o755)
  assert.equal((await promisify(execFile)(file)).stdout, 'after\n', 'saved script remains directly executable')
})
test('predictable historical scratch aliases cannot write or remove an unrelated file', async t => {
  const root = await fixture(t), project = path.join(root, 'project'), outside = path.join(root, 'unrelated.txt')
  await mkdir(project); await writeFile(outside, 'must remain unchanged\n')
  const file = path.join(project, 'a.mjs'); await writeFile(file, 'original\n')
  await symlink(outside, file + '.kkcode.tmp'); await symlink(outside, file + '.kkcode.bak')
  await atomicWriteFile(file, 'replacement\n')
  assert.equal(await readFile(outside, 'utf8'), 'must remain unchanged\n')
  assert.deepEqual((await readdir(project)).sort(), ['a.mjs', 'a.mjs.kkcode.bak', 'a.mjs.kkcode.tmp'])
})
test('a missing target is created without predictable backup or staging remnants', async t => {
  const root = await fixture(t), file = path.join(root, 'nested', 'new.txt')
  await atomicWriteFile(file, 'new\n')
  assert.equal(await readFile(file, 'utf8'), 'new\n')
  assert.deepEqual(await readdir(path.dirname(file)), ['new.txt'])
})
test('atomic helper refuses symbolic and hard-linked targets instead of silently replacing aliases', async t => {
  const root = await fixture(t), file = path.join(root, 'original.txt'), alias = path.join(root, 'alias.txt')
  await writeFile(file, 'original\n'); await symlink(file, alias)
  await assert.rejects(atomicWriteFile(alias, 'replacement\n'), /regular.*single-link|single-link.*regular/i)
  assert.equal(await readFile(file, 'utf8'), 'original\n')
  await rm(alias); await link(file, alias)
  await assert.rejects(atomicWriteFile(file, 'replacement\n'), /regular.*single-link|single-link.*regular/i)
  assert.equal(await readFile(alias, 'utf8'), 'original\n')
})

test('failed staging never restores a backup over the original or leaves private buffers', async t => {
  const root = await fixture(t), file = path.join(root, 'original.txt')
  await writeFile(file, 'original\n')
  const probe = await open(file, 'r'), proto = Object.getPrototypeOf(probe)
  await probe.close()
  t.mock.method(proto, 'chmod', async () => {throw Object.assign(Error('controlled staging failure'), {code: 'EACCES'})})
  await assert.rejects(atomicWriteFile(file, 'replacement\n'), /controlled staging/)
  assert.equal(await readFile(file, 'utf8'), 'original\n')
  assert.deepEqual(await readdir(root), ['original.txt'])
})

test('an external change made while staging wins instead of being clobbered or restored away', async t => {
  const root = await fixture(t), file = path.join(root, 'original.txt')
  await writeFile(file, 'original\n')
  const probe = await open(file, 'r'), proto = Object.getPrototypeOf(probe), originalChmod = proto.chmod
  await probe.close()
  t.mock.method(proto, 'chmod', async function (...args) {await writeFile(file, 'changed by owner during preparation\n'); return originalChmod.apply(this, args)})
  await assert.rejects(atomicWriteFile(file, 'replacement\n'), /target changed/)
  assert.equal(await readFile(file, 'utf8'), 'changed by owner during preparation\n')
  assert.deepEqual(await readdir(root), ['original.txt'])
})

test('changed code does not retain setuid/setgid permission grants', {skip: process.platform === 'win32'}, async t => {
  const root = await fixture(t), file = path.join(root, 'script.sh')
  await writeFile(file, '#!/bin/sh\necho before\n'); await chmod(file, 0o6755)
  await atomicWriteFile(file, '#!/bin/sh\necho after\n')
  assert.equal((await stat(file)).mode & 0o7777, 0o755)
})

test('ownership-preservation failure cannot publish replacement bytes', {skip: process.platform === 'win32'}, async t => {
  const root = await fixture(t), file = path.join(root, 'private.txt')
  await writeFile(file, 'original\n'); await chmod(file, 0o600)
  const probe = await open(file, 'r'), proto = Object.getPrototypeOf(probe), originalStat = proto.stat
  await probe.close()
  t.mock.method(proto, 'stat', async function (...args) {const info = await originalStat.apply(this, args); return {...info, uid: info.uid + 1n}})
  t.mock.method(proto, 'chown', async () => {throw Object.assign(Error('controlled ownership failure'), {code: 'EPERM'})})
  await assert.rejects(atomicWriteFile(file, 'replacement\n'), /controlled ownership failure/)
  assert.equal(await readFile(file, 'utf8'), 'original\n')
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(root), ['private.txt'])
})

test('actual differing POSIX group survives atomic replacement', {skip: process.platform === 'win32' || process.getuid?.() !== 0}, async t => {
  const root = await fixture(t), file = path.join(root, 'shared.txt')
  await writeFile(file, 'original\n'); await chown(file, 0, 1); await chmod(file, 0o640)
  await atomicWriteFile(file, 'replacement\n')
  const info = await stat(file)
  assert.equal(info.uid, 0); assert.equal(info.gid, 1); assert.equal(info.mode & 0o777, 0o640)
  assert.equal(await readFile(file, 'utf8'), 'replacement\n')
})
