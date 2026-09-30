import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createToolRegistry } from '../src/kernel/tool/registry.mjs'
import { runWithRuntime } from '../src/kernel/core/runtime-context.mjs'
import { createBackgroundTask, readBackgroundTask } from '../src/kernel/orchestration/background-task-store.mjs'
import { BackgroundManager } from '../src/kernel/orchestration/background-manager.mjs'

const config = { tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } }, mcp: { auto_discover: false }, runtime: {} }
let root, previousHome, registry
const task = (id, parentSessionId, status = 'pending') => ({ id, status, description: id, cancelled: false, attempt: 1,
  payload: { parentSessionId, subagent: 'worker', subSessionId: `child_${id}` }, logs: [], result: { reply: `private result ${id}` } })
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'kk-background-scope-'))
  previousHome = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = root
  registry = createToolRegistry()
  await registry.initialize({ config, cwd: root })
  await Promise.all([createBackgroundTask(task('owned', 'owner')), createBackgroundTask(task('foreign', 'other')), createBackgroundTask(task('legacy', null))])
})
afterEach(async () => {
  if (previousHome === undefined) delete process.env.KKCODE_HOME
  else process.env.KKCODE_HOME = previousHome
  await rm(root, { recursive: true, force: true })
})
const invoke = async (name, args = {}, ctx = { sessionId: 'owner' }) => (await registry.get(name)).execute(args, ctx)

test('all legacy output aliases deny foreign and unowned task output without leaking existence', async () => {
  for (const name of ['background_output', 'task_get', 'task_output']) {
    assert.equal((await invoke(name, { task_id: 'owned' })).result.reply, 'private result owned')
    const missing = await invoke(name, { task_id: 'missing' })
    assert.equal(await invoke(name, { task_id: 'foreign', sessionId: 'other' }), missing)
    assert.equal(await invoke(name, { task_id: 'legacy' }), missing)
  }
})

test('list and parallel aliases filter canonical owner before projecting results', async () => {
  assert.deepEqual((await invoke('task_list', { parentSessionId: 'other' })).map(row => row.id), ['owned'])
  const groups = await invoke('task_parallel')
  assert.equal(groups.length, 1)
  assert.equal(groups[0].parent_session_id, 'owner')
  assert.deepEqual(groups[0].lanes.map(row => row.id), ['owned'])
  assert.equal(JSON.stringify(groups).includes('foreign'), false)
})

test('both stop aliases refuse other-session and legacy tasks but cancel owned work', async () => {
  for (const name of ['task_stop', 'background_cancel']) {
    assert.equal(await invoke(name, { task_id: 'foreign', parentSessionId: 'other' }), 'background task not found')
    assert.equal(await invoke(name, { task_id: 'legacy' }), 'background task not found')
    assert.equal(await invoke(name, { task_id: 'owned' }), 'cancel requested')
  }
  assert.equal((await readBackgroundTask('owned')).status, 'cancelled')
  assert.equal((await readBackgroundTask('foreign')).status, 'pending')
  assert.equal((await readBackgroundTask('legacy')).status, 'pending')
  await createBackgroundTask(task('foreign_done', 'other', 'completed'))
  assert.equal(await BackgroundManager.cancel('foreign_done', { parentSessionId: 'owner' }), false)
  assert.equal((await readBackgroundTask('foreign_done')).result.reply, 'private result foreign_done')
})

test('ambient runtime scope cannot be replaced or omitted to regain global access', async () => {
  await runWithRuntime({ sessionId: 'owner' }, async () => {
    assert.deepEqual((await invoke('task_list', {}, {})).map(row => row.id), ['owned'])
    await assert.rejects(invoke('task_list', {}, { sessionId: 'other' }), { code: 'background_task_scope' })
    await assert.rejects(invoke('task_stop', { task_id: 'foreign' }, { sessionId: '' }), { code: 'background_task_scope' })
  })
  assert.equal((await readBackgroundTask('foreign')).status, 'pending')
})

test('trusted direct host calls outside a session keep explicit legacy administration compatibility', async () => {
  assert.equal((await invoke('task_list', {}, {})).length, 3)
  assert.equal((await invoke('task_output', { task_id: 'legacy' }, {})).result.reply, 'private result legacy')
  assert.equal(await invoke('task_stop', { task_id: 'legacy' }, {}), 'cancel requested')
  assert.equal((await readBackgroundTask('legacy')).status, 'cancelled')
  for (const sessionId of ['', 0, {}, []]) await assert.rejects(invoke('task_list', {}, { sessionId }), { code: 'background_task_scope' })
})
