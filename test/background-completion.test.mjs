import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ToolRegistry } from '../src/kernel/tool/registry.mjs'
import { executeTool } from '../src/kernel/tool/executor.mjs'
import { BackgroundManager } from '../src/kernel/orchestration/background-manager.mjs'
import { collectBackgroundCompletionEvidence } from '../src/kernel/session/background-completion.mjs'
import { evaluateCompletionEvidence } from '../src/kernel/session/completion-evidence.mjs'

let root, previousRoot
const tasks = new Set()
const config = { permission: { level: 'yolo', rules: [] }, tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } } }
const command = code => `"${process.execPath}" -e "eval(Buffer.from('${Buffer.from(code).toString('base64')}','base64').toString())"`
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const collect = (toolEvents = [], parts = []) => collectBackgroundCompletionEvidence({ sessionId: 'owner', toolEvents, parts, cwd: root })
const settled = id => BackgroundManager.waitForTask(id, { timeoutMs: 10000, tickMs: 20 })
async function launch(shellCommand, options = {}) {
  const startedAt = Date.now(), args = { command: shellCommand, run_in_background: true, ...(options.env ? { env: options.env } : {}) }
  const result = await executeTool({ tool: await ToolRegistry.get('bash'), args, sessionId: 'owner', turnId: 'owned-turn', invocationId: 'launch-call',
    context: { cwd: root, config, sessionId: 'owner', turnId: 'owned-turn', toolCallId: 'launch-call', signal: options.signal } })
  const id = result.metadata.backgroundTask.id; tasks.add(id)
  return { id, event: { ...result, args, startedAt, completedAt: Date.now() } }
}
const successfulCheck = (startedAt, completedAt) => ({ name: 'bash', args: { command: 'node --check safe.mjs' },
  status: 'completed', ok: true, startedAt, completedAt, metadata: { exitCode: 0, started: true, timedOut: false, cancelled: false, captureIncomplete: false } })
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'kk-bg-completion-')); previousRoot = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  await ToolRegistry.initialize({ cwd: root, config, force: true, allowProjectSources: false })
})
afterEach(async () => {
  for (const id of tasks) { await BackgroundManager.cancel(id); await settled(id) }
  tasks.clear()
  if (previousRoot === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previousRoot
  await rm(root, { recursive: true, force: true })
})

test('Bash launch has durable session/turn ownership and is pending, not completion', async () => {
  const launched = await launch(command('setTimeout(() => {}, 800)'))
  const task = await BackgroundManager.get(launched.id)
  assert.equal(task.payload.parentSessionId, 'owner')
  assert.equal(task.payload.turnId, 'owned-turn')
  assert.equal(task.payload.toolCallId, 'launch-call')
  assert.equal(launched.event.metadata.backgroundTask.phase, 'submitted')
  const result = await collect([launched.event])
  assert.equal(result.pending[0].id, launched.id)
  assert.equal(result.events.length, 0, 'launch ack is not an executed command result')
  assert.equal(result.unknown, false)
  assert.deepEqual((await collectBackgroundCompletionEvidence({ sessionId: 'foreign' })).pending, [])
})

test('a check that finished after background mutation but began before it settled cannot verify it', async () => {
  const launched = await launch(command('console.log("done")'))
  const task = await settled(launched.id), ended = task.endedAt
  const stale = successfulCheck(ended - 20, ended + 100)
  const result = await collect([launched.event, stale])
  assert.equal(result.pending.length, 0)
  assert.equal(result.needsFreshVerification, true)
  assert.equal(result.unknown, false)
  assert.equal(result.events[0], stale)
  assert.equal(result.events.at(-1).metadata.backgroundTask.phase, 'settled')
  assert.equal(evaluateCompletionEvidence({ toolEvents: result.events, requireChecks: result.needsFreshVerification }).passed, false)
  const fresh = await collect([launched.event, stale, successfulCheck(ended + 1, ended + 120)])
  assert.equal(evaluateCompletionEvidence({ toolEvents: fresh.events, requireChecks: fresh.needsFreshVerification }).passed, true)
  const equal = await collect([launched.event, successfulCheck(ended, ended + 150)])
  assert.equal(evaluateCompletionEvidence({ toolEvents: equal.events }).passed, false, 'equal timestamp cannot prove ordering')
})

test('a settled background verification command may contribute its actual process receipt', async () => {
  await writeFile(path.join(root, 'safe.mjs'), 'export const safe = true\n')
  const launched = await launch('node --check safe.mjs')
  await settled(launched.id)
  const result = await collect([launched.event])
  assert.equal(result.pending.length, 0)
  assert.equal(result.needsFreshVerification, false)
  assert.equal(result.events[0].metadata.exitCode, 0)
  assert.equal(evaluateCompletionEvidence({ toolEvents: result.events }).state, 'checks_observed')
})

test('background environment values stay private and are not silently accepted as verification identity', async () => {
  await writeFile(path.join(root, 'safe.mjs'), 'export const safe = true\n')
  const launched = await launch('node --check safe.mjs', { env: { CI: 'sensitive-fixture-value' } })
  const task = await settled(launched.id)
  assert.equal(task.payload.envProvided, true)
  assert.doesNotMatch(JSON.stringify(task), /sensitive-fixture-value/)
  const result = await collect([launched.event])
  assert.equal(result.needsFreshVerification, true)
  assert.equal(result.events[0].metadata.verificationEnvUnknown, true)
  assert.equal(evaluateCompletionEvidence({ toolEvents: result.events, requireChecks: result.needsFreshVerification, cwd: root }).passed, false)
  const fresh = await collect([launched.event, successfulCheck(task.endedAt + 1, task.endedAt + 100)])
  assert.equal(evaluateCompletionEvidence({ toolEvents: fresh.events, requireChecks: fresh.needsFreshVerification, cwd: root }).passed, true)
})

test('legacy string results and lost records remain unknown regardless of later green checks', async () => {
  const task = await BackgroundManager.launch({ description: 'legacy', payload: { parentSessionId: 'owner', command: 'echo legacy', cwd: root }, run: async () => 'old runner claimed success' })
  tasks.add(task.id); const terminal = await settled(task.id)
  const result = await collect([successfulCheck(terminal.endedAt + 1, terminal.endedAt + 20)])
  assert.equal(result.unknown, true)
  assert.equal(evaluateCompletionEvidence({ toolEvents: result.events }).passed, false)
  const lost = await collect([{ name: 'bash', args: { command: 'echo missing', run_in_background: true }, status: 'completed', metadata: { backgroundTask: { id: 'bg_missing', phase: 'submitted' } } }])
  assert.equal(lost.unknown, true)
  assert.ok(lost.events.some(event => event.metadata?.reason === 'background_record_missing_or_foreign'))
})

test('blocked background dispatch is not mistaken for a launched process with missing evidence', async () => {
  const result = await collect([{ name: 'bash', args: { command: 'forbidden', run_in_background: true }, status: 'blocked', ok: false }])
  assert.equal(result.unknown, false)
  assert.equal(result.events.length, 1)
})

test('old completed marker does not waive a background mutation without a later-starting actual check', async () => {
  const launched = await launch(command('console.log("done")'))
  const task = await settled(launched.id), end = task.endedAt
  const marker = { type: 'turn-outcome', source: 'host', schema: 'kk.turn-outcome.v1', status: 'completed', createdAt: end + 200 }
  const before = { type: 'tool-call', tool: 'bash', ...successfulCheck(end - 10, end + 100) }
  assert.equal((await collect([], [before, marker])).events.length, 1)
  const after = { ...before, startedAt: end + 1 }
  assert.equal((await collect([], [after, marker])).events.length, 0)
})

test('known failed background check stays resolved after an exact later repair check and accepted turn', async () => {
  await writeFile(path.join(root, 'safe.mjs'), 'invalid syntax {\n')
  const launched = await launch('node --check safe.mjs')
  const task = await settled(launched.id), end = task.endedAt
  assert.equal(task.status, 'error')
  const fresh = { type: 'tool-call', tool: 'bash', ...successfulCheck(end + 1, end + 100) }
  const marker = { type: 'turn-outcome', source: 'host', schema: 'kk.turn-outcome.v1', status: 'completed', createdAt: end + 200 }
  assert.equal((await collect([], [fresh, marker])).events.length, 0)
  const unrelated = { ...fresh, args: { command: 'npm run lint' } }
  assert.equal((await collect([], [unrelated, marker])).events.length, 1)
})

test('parent abort stops its owned finite background command instead of leaving future writes', async () => {
  const controller = new AbortController(), ready = path.join(root, 'ready'), later = path.join(root, 'later')
  const launched = await launch(command(`require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(later)}, 'bad'), 900); setTimeout(() => {}, 1100)`), { signal: controller.signal })
  for (let index = 0; index < 200; index++) { if (await access(ready).then(() => true, () => false)) break; await pause(10) }
  await access(ready); controller.abort()
  const task = await settled(launched.id)
  assert.equal(task.status, 'cancelled')
  await pause(1000)
  await assert.rejects(access(later), { code: 'ENOENT' })
})
