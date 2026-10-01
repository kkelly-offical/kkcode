import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, rm, writeFile, readFile, symlink, lstat, open, rename} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {ToolRegistry} from '../src/kernel/tool/registry.mjs'
import {executeTool} from '../src/kernel/tool/executor.mjs'
import {isToolNotStarted} from '../src/kernel/core/execution-outcome.mjs'

const config = {permission: {level: 'yolo', rules: []}, git: {auto: {enabled: false}}, tool: {sources: {builtin: true, local: false, plugin: false, mcp: false}}}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-atomic-preflight-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  t.after(async () => {if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, {recursive: true, force: true})})
  await writeFile(path.join(root, 'a.txt'), 'before A\n'); await writeFile(path.join(root, 'b.txt'), 'before B\n')
  await symlink(path.join(root, 'b.txt'), path.join(root, 'alias.txt'))
  await ToolRegistry.initialize({config, cwd: root, force: true, allowProjectSources: false})
  return {root, call: async (name, args, tool = null) => executeTool({tool: tool || await ToolRegistry.get(name), args, sessionId: 'preflight-owner', turnId: 'preflight-turn', context: {cwd: root, config}})}
}

test('native multiedit checks all targets before any member or operation is dispatched', async t => {
  const {root, call} = await fixture(t)
  await call('read', {path: 'a.txt'}); await call('read', {path: 'alias.txt'})
  const result = await call('multiedit', {changes: [{path: 'a.txt', before: 'before A', after: 'after A'}, {path: 'alias.txt', before: 'before B', after: 'after B'}]})
  assert.equal(result.status, 'error'); assert.equal(result.code, 'unsafe_atomic_target')
  assert.equal(isToolNotStarted(result), true); assert.equal(result.metadata.started, false)
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'before A\n')
  assert.equal(await readFile(path.join(root, 'b.txt'), 'utf8'), 'before B\n')
  assert.equal((await lstat(path.join(root, 'alias.txt'))).isSymbolicLink(), true)
})

test('a copied name/source cannot forge native preflight implementation identity', async t => {
  const {call} = await fixture(t)
  let invoked = 0
  const custom = {name: 'write', source: 'builtin', inputSchema: {type: 'object'}, async execute() {invoked++; return 'custom observed'}}
  const result = await call('write', {path: 'alias.txt', content: 'not written'}, custom)
  assert.equal(invoked, 1); assert.equal(isToolNotStarted(result), false)
  assert.equal(result.status, 'completed')
})

test('a target swapped after preflight still retains unknown effects and cannot manufacture no-start proof', async t => {
  const {root, call} = await fixture(t), file = path.join(root, 'a.txt'), saved = path.join(root, 'saved.txt')
  await call('read', {path: 'a.txt'})
  const probe = await open(file, 'r'), proto = Object.getPrototypeOf(probe), originalWrite = proto.writeFile
  await probe.close()
  t.mock.method(proto, 'writeFile', async function (content, ...args) {
    const result = await originalWrite.call(this, content, ...args)
    if (content === 'after A\n') {await rename(file, saved); await symlink(path.join(root, 'b.txt'), file)}
    return result
  })
  const result = await call('write', {path: 'a.txt', content: 'after A\n'})
  assert.equal(result.status, 'error'); assert.equal(result.code, 'atomic_target_changed')
  assert.equal(result.metadata.outcomeUnknown, true); assert.equal(isToolNotStarted(result), false)
  assert.equal(await readFile(saved, 'utf8'), 'before A\n')
  assert.equal(await readFile(path.join(root, 'b.txt'), 'utf8'), 'before B\n')
})
