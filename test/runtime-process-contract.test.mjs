import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, access } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ToolRegistry } from '../src/kernel/tool/registry.mjs'
import { executeTool } from '../src/kernel/tool/executor.mjs'
import { BackgroundManager } from '../src/kernel/orchestration/background-manager.mjs'
import { runManagedProcess } from '../src/kernel/tool/managed-process.mjs'

let root, previousRoot
const tasks = new Set()
const config = { permission: { level: 'yolo', rules: [] }, tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } }, git: { auto: { enabled: false } } }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const command = code => `"${process.execPath}" -e "eval(Buffer.from('${Buffer.from(code).toString('base64')}','base64').toString())"`
const exists = file => access(file).then(() => true, () => false)
async function waitUntil(predicate) {
  for (let i = 0; i < 300; i++) { if (await predicate()) return; await pause(10) }
  assert.fail('fixture did not become ready')
}
async function bash(args, signal = null) {
  return executeTool({ tool: await ToolRegistry.get('bash'), args, sessionId: 'process-contract', turnId: 'process-turn', signal,
    context: { cwd: root, config } })
}
async function background(args) {
  const launched = await bash({ ...args, run_in_background: true })
  const id = launched.output.match(/background task launched: (\S+)/)?.[1]
  assert.ok(id, launched.output); tasks.add(id)
  return id
}
async function settled(id) { return BackgroundManager.waitForTask(id, { timeoutMs: 10000, tickMs: 20 }) }
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'kk-process-contract-'))
  previousRoot = process.env.KKCODE_HOME; process.env.KKCODE_HOME = path.join(root, 'state')
  await ToolRegistry.initialize({ config, cwd: root, force: true, allowProjectSources: false })
})
afterEach(async () => {
  for (const id of tasks) { await BackgroundManager.cancel(id); await settled(id) }
  tasks.clear()
  if (previousRoot === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previousRoot
  await rm(root, { recursive: true, force: true })
})

test('short Bash nonzero output is a failed tool with structured exit evidence', async () => {
  const result = await bash({ command: 'exit 7' })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'error')
  assert.equal(result.metadata.exitCode, 7)
  assert.equal(result.evidence.exitCode, 7)
  assert.equal(result.metadata.timedOut, false)
  assert.equal(result.metadata.cancelled, false)
  assert.equal(result.metadata.captureIncomplete, false)
  assert.match(result.output, /\[exit 7\]/)
})

test('successful Bash stderr remains success with complete structured metadata', async () => {
  const result = await bash({ command: command("process.stderr.write('progress')") })
  assert.equal(result.ok, true)
  assert.equal(result.metadata.exitCode, 0)
  assert.equal(result.metadata.timedOut, false)
  assert.equal(result.metadata.cancelled, false)
  assert.equal(result.metadata.captureIncomplete, false)
  assert.equal(result.output, 'progress')
})

test('foreground timeout preserves output and never settles successfully', async () => {
  const result = await bash({ command: command("console.log('partial'); setTimeout(() => {}, 1500)"), timeout: 1000 })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'error')
  assert.equal(result.metadata.timedOut, true)
  assert.equal(result.metadata.cancelled, false)
  assert.match(result.output, /partial/)
  assert.equal(result.metadata.outcomeUnknown, true)
})

test('executor forwards its AbortSignal and cancellation terminates before natural exit', async () => {
  const ready = path.join(root, 'ready')
  const controller = new AbortController()
  const pending = bash({ command: command(`require('node:fs').writeSync(1, 'partial'); require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => {}, 1800)`) }, controller.signal)
  await waitUntil(() => exists(ready))
  const started = Date.now(); controller.abort()
  const result = await pending
  assert.ok(Date.now() - started < 1300, 'cancellation must stop the process, not just relabel its eventual result')
  assert.equal(result.status, 'cancelled')
  assert.equal(result.metadata.cancelled, true)
  assert.equal(result.metadata.timedOut, false)
  assert.match(result.output, /partial/)
  assert.equal(result.metadata.outcomeUnknown, true)
})

test('background Bash nonzero result is retained and classified as error', async () => {
  const task = await settled(await background({ command: 'exit 9' }))
  assert.equal(task.status, 'error')
  assert.equal(task.result.metadata.exitCode, 9)
  assert.match(task.result.output, /\[exit 9\]/)
})

test('background Bash respects the same requested timeout as foreground', async () => {
  const task = await settled(await background({ command: command("console.log('partial'); setTimeout(() => {}, 1600)"), timeout: 1000 }))
  assert.equal(task.status, 'error')
  assert.equal(task.result.metadata.timedOut, true)
  assert.match(task.result.output, /partial/)
})

test('background cancellation signals the real process and retains partial result', async () => {
  const ready = path.join(root, 'ready')
  const id = await background({ command: command(`require('node:fs').writeSync(1, 'partial'); require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => {}, 1800)`) })
  await waitUntil(() => exists(ready))
  const started = Date.now(); await BackgroundManager.cancel(id)
  const task = await settled(id)
  assert.ok(Date.now() - started < 1300)
  assert.equal(task.status, 'cancelled')
  assert.equal(task.result.metadata.cancelled, true)
  assert.match(task.result.output, /partial/)
})

test('cancellation stops inherited child processes before later side effects', async () => {
  const ready = path.join(root, 'child-ready'), later = path.join(root, 'child-later')
  const childCode = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(later)}, 'must not happen'), 1400); setTimeout(() => {}, 1600)`
  const parentCode = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'inherit' }); setTimeout(() => {}, 1800)`
  const controller = new AbortController(), pending = bash({ command: command(parentCode) }, controller.signal)
  await waitUntil(() => exists(ready)); controller.abort()
  const result = await pending
  assert.equal(result.status, 'cancelled')
  await pause(1500)
  assert.equal(await exists(later), false, 'cancelled process descendants must not keep writing')
})

test('another process can cancel an inline Bash task through its durable record', async () => {
  const ready = path.join(root, 'cross-process-ready')
  const id = await background({ command: command(`require('node:fs').writeSync(1, 'partial'); require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => {}, 2500)`) })
  await waitUntil(() => exists(ready))
  const moduleUrl = new URL('../src/kernel/orchestration/background-manager.mjs', import.meta.url).href
  const stopped = await runManagedProcess({ command: process.execPath,
    args: ['--input-type=module', '-e', `const { BackgroundManager } = await import(${JSON.stringify(moduleUrl)}); await BackgroundManager.cancel(${JSON.stringify(id)});`] })
  assert.equal(stopped.exitCode, 0)
  const task = await settled(id)
  assert.equal(task.status, 'cancelled')
  assert.equal(task.result.metadata.cancelled, true)
  assert.match(task.result.output, /partial/)
})

test('cancelling a completed background process leaves its settled result unchanged', async () => {
  const id = await background({ command: 'echo done' })
  const before = await settled(id)
  assert.equal(before.status, 'completed')
  await BackgroundManager.cancel(id)
  const after = await BackgroundManager.get(id)
  assert.equal(after.status, 'completed')
  assert.equal(after.cancelled, false)
  assert.deepEqual(after.result, before.result)
  assert.equal(after.interruptionReason, before.interruptionReason)
})
