import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, rm, writeFile, readFile, open} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {ToolRegistry} from '../src/kernel/tool/registry.mjs'

const config = {tool: {sources: {builtin: true, local: false, plugin: false, mcp: false}}}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-multiedit-recovery-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  await writeFile(path.join(root, 'a.txt'), 'original A\n'); await writeFile(path.join(root, 'b.txt'), 'original B\n')
  await ToolRegistry.initialize({config, cwd: root, force: true, allowProjectSources: false})
  const read = await ToolRegistry.get('read')
  for (const file of ['a.txt', 'b.txt']) await read.execute({path: file}, {cwd: root, config})
  const handle = await open(path.join(root, 'a.txt'), 'r'), proto = Object.getPrototypeOf(handle)
  await handle.close()
  return {root, proto, tool: await ToolRegistry.get('multiedit')}
}
const changes = [{path: 'a.txt', before: 'original A', after: 'candidate A'}, {path: 'b.txt', before: 'original B', after: 'candidate B'}]

test('multiedit failure cannot restore a stale backup over a concurrent owner change', async t => {
  const {root, proto, tool} = await fixture(t), original = proto.writeFile
  t.mock.method(proto, 'writeFile', async function (content, ...args) {
    if (content === 'candidate B\n') {await writeFile(path.join(root, 'a.txt'), 'concurrent owner change\n'); throw Error('controlled second-file failure')}
    return original.call(this, content, ...args)
  })
  const result = await tool.execute({changes}, {cwd: root, config})
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'concurrent owner change\n')
  assert.equal(await readFile(path.join(root, 'b.txt'), 'utf8'), 'original B\n')
  assert.equal(result.metadata.outcomeUnknown, true)
  assert.doesNotMatch(result.output, /all changes rolled back/i)
})

test('failed rollback preserves partial files and explicitly requires inspection rather than claiming rollback', async t => {
  const {root, proto, tool} = await fixture(t), original = proto.writeFile
  t.mock.method(proto, 'writeFile', async function (content, ...args) {
    if (content === 'candidate B\n' || content === 'original A\n') throw Error('controlled write/rollback failure')
    return original.call(this, content, ...args)
  })
  const result = await tool.execute({changes}, {cwd: root, config})
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'candidate A\n')
  assert.equal(result.metadata.outcomeUnknown, true)
  assert.equal(result.metadata.rollback.complete, false)
  assert.doesNotMatch(result.output, /all changes rolled back/i)
})

test('newly-created members are recovered privately, never irreversibly unlinked', async t => {
  const {root, proto, tool} = await fixture(t), original = proto.writeFile
  t.mock.method(proto, 'writeFile', async function (content, ...args) {if (content === 'candidate B\n') throw Error('controlled second-file failure'); return original.call(this, content, ...args)})
  const result = await tool.execute({changes: [{path: 'new.txt', after: 'created content\n'}, changes[1]]}, {cwd: root, config})
  assert.equal(result.metadata.rollback.complete, true)
  await assert.rejects(readFile(path.join(root, 'new.txt')), {code: 'ENOENT'})
  assert.equal(result.metadata.rollback.recoveryFiles.length, 1)
  const recovery = result.metadata.rollback.recoveryFiles[0].recoveryPath
  assert.match(recovery, /\.kkcode-rollback-/)
  assert.equal(await readFile(recovery, 'utf8'), 'created content\n')
})

test('changed newly-created member is preserved in place and not deleted during recovery', async t => {
  const {root, proto, tool} = await fixture(t), original = proto.writeFile
  t.mock.method(proto, 'writeFile', async function (content, ...args) {
    if (content === 'candidate B\n') {await writeFile(path.join(root, 'new.txt'), 'owner changed new file\n'); throw Error('controlled second-file failure')}
    return original.call(this, content, ...args)
  })
  const result = await tool.execute({changes: [{path: 'new.txt', after: 'created content\n'}, changes[1]]}, {cwd: root, config})
  assert.equal(result.metadata.outcomeUnknown, true)
  assert.equal(await readFile(path.join(root, 'new.txt'), 'utf8'), 'owner changed new file\n')
})

test('batch cancellation preserves committed members and stops before further writes', async t => {
  const {root, proto, tool} = await fixture(t), original = proto.writeFile, controller = new AbortController()
  t.mock.method(proto, 'writeFile', async function (content, ...args) {const result = await original.call(this, content, ...args); if (content === 'candidate A\n') controller.abort(); return result})
  const result = await tool.execute({changes}, {cwd: root, config, signal: controller.signal})
  assert.equal(result.status, 'cancelled'); assert.equal(result.metadata.outcomeUnknown, true)
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'candidate A\n')
  assert.equal(await readFile(path.join(root, 'b.txt'), 'utf8'), 'original B\n')
})
