import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, open, rm, link, chmod} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {writePrivateFile} from '../src/storage/private-file.mjs'
import {listToolOperations} from '../src/kernel/tool/operation-journal.mjs'

test('operation journal reopens a private snapshot replaced between open and stat', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-journal-snapshot-'))
  const oldRoot = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = root
  t.after(async () => {if (oldRoot === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = oldRoot; await rm(root, {recursive: true, force: true})})
  const file = path.join(root, 'operations', 'owner.json')
  const snapshot = id => JSON.stringify({version: 1, operations: [{id, state: 'uncertain'}]})
  await writePrivateFile(file, snapshot('before'))
  const probe = await open(file, 'r'), proto = Object.getPrototypeOf(probe), stat = proto.stat
  await probe.close()
  let replacements = 0
  t.mock.method(proto, 'stat', async function (...args) {
    if (replacements++ === 0) await writePrivateFile(file, snapshot('after'))
    return stat.apply(this, args)
  })
  assert.deepEqual(await listToolOperations('owner'), [{id: 'after', state: 'uncertain'}])
  t.mock.restoreAll()
  await link(file, path.join(root, 'hard-link'))
  await assert.rejects(listToolOperations('owner'), /private regular file/, 'a linked snapshot remains forbidden')
  await rm(path.join(root, 'hard-link'))
  await chmod(file, 0o644)
  if (process.getuid) await assert.rejects(listToolOperations('owner'), /private regular file/, 'replacement handling does not relax permissions')
})

test('continuous atomic replacements fail boundedly instead of accepting an unlinked journal', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-journal-churn-')), oldRoot = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = root
  t.after(async () => {if (oldRoot === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = oldRoot; await rm(root, {recursive: true, force: true})})
  const file = path.join(root, 'operations', 'owner.json'), snapshot = JSON.stringify({version: 1, operations: []})
  await writePrivateFile(file, snapshot)
  const probe = await open(file, 'r'), proto = Object.getPrototypeOf(probe), stat = proto.stat
  await probe.close()
  let attempts = 0
  t.mock.method(proto, 'stat', async function (...args) {attempts++; await writePrivateFile(file, snapshot); return stat.apply(this, args)})
  await assert.rejects(listToolOperations('owner'), /replaced repeatedly/)
  assert.ok(attempts <= 8)
})
