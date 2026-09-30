import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, readFile, access, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { ToolRegistry } from '../src/kernel/tool/registry.mjs'
import { BackgroundManager } from '../src/kernel/orchestration/background-manager.mjs'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const exists = target => access(target).then(() => true, () => false)
const config = { permission: { level: 'yolo', rules: [] }, tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } }, git: { auto: { enabled: false } } }
const command = code => `"${process.execPath}" -e "eval(Buffer.from('${Buffer.from(code).toString('base64')}','base64').toString())"`

async function within(promise, ms, message) {
  let timer
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })])
  } finally { clearTimeout(timer) }
}

test('an in-flight heartbeat cannot erase cancellation committed by another process', { timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-background-cancel-race-'))
  const previousHome = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  const ready = path.join(root, 'ready'), later = path.join(root, 'later')
  const originalRename = fs.promises.rename
  let taskId, cancellingChild, cancellationDone, releaseHeartbeat, notifyHeartbeat
  let heartbeatHeld = false
  const heartbeatReady = new Promise(resolve => { notifyHeartbeat = resolve })
  const heartbeatRelease = new Promise(resolve => { releaseHeartbeat = resolve })
  try {
    await ToolRegistry.initialize({ config, cwd: root, force: true, allowProjectSources: false })
    const code = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => fs.writeFileSync(${JSON.stringify(later)}, 'effect after cancellation'), 5000); setTimeout(() => {}, 5100)`
    const launched = await ToolRegistry.call('bash', { command: command(code), run_in_background: true }, { cwd: root, config, sessionId: 'cancel-race-fixture' })
    taskId = launched.output.match(/background task launched: (\S+)/)?.[1]
    assert.ok(taskId, launched.output)
    await within((async () => { while (!(await exists(ready))) await pause(10) })(), 3000, 'Bash child did not become ready')
    const childReadyAt = Date.now()

    // Pause only this owned task's heartbeat after it has constructed its next
    // checkpoint and reached the actual filesystem commit boundary. This does
    // not replace the manager, its reads, its cancellation or the real process.
    fs.promises.rename = async (from, to) => {
      if (!heartbeatHeld && String(to).endsWith(`${taskId}.json`)) {
        const next = JSON.parse(await readFile(from, 'utf8'))
        if (next.status === 'running' && next.cancelled === false && next._version >= 2) {
          heartbeatHeld = true
          notifyHeartbeat()
          await heartbeatRelease
        }
      }
      return originalRename(from, to)
    }
    syncBuiltinESMExports()
    await within(heartbeatReady, 3000, 'Heartbeat never reached the commit boundary')

    const managerUrl = new URL('../src/kernel/orchestration/background-manager.mjs', import.meta.url).href
    const cancelCode = `const { BackgroundManager } = await import(${JSON.stringify(managerUrl)}); console.log('cancel-started'); console.log('cancel-result:' + await BackgroundManager.cancel(${JSON.stringify(taskId)}));`
    cancellingChild = spawn(process.execPath, ['--input-type=module', '-e', cancelCode], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let cancelOutput = '', cancelError = '', notifyCancelStarted
    const cancelStarted = new Promise(resolve => { notifyCancelStarted = resolve })
    cancellingChild.stdout.on('data', chunk => {
      cancelOutput += chunk
      if (cancelOutput.includes('cancel-started')) notifyCancelStarted()
    })
    cancellingChild.stderr.on('data', chunk => { cancelError += chunk })
    cancellationDone = new Promise((resolve, reject) => {
      cancellingChild.once('error', reject)
      cancellingChild.once('close', code => code === 0 ? resolve() : reject(new Error(`Cancellation subprocess exited ${code}: ${cancelError}`)))
    })
    await within(cancelStarted, 3000, 'Cancellation subprocess did not start')
    // A correct cross-process lock blocks cancellation while the heartbeat owns
    // the commit. Bound this barrier instead of awaiting cancellation forever.
    // The vulnerable implementation commits cancellation first, then the held
    // heartbeat overwrites cancelled:true with its stale cancelled:false.
    await Promise.race([cancellationDone, pause(1000)])
    releaseHeartbeat()
    await within(cancellationDone, 4000, 'Cancellation did not finish after heartbeat release')
    assert.match(cancelOutput, /cancel-result:true/)

    const settled = await BackgroundManager.waitForTask(taskId, { timeoutMs: 8000, tickMs: 20 })
    await pause(Math.max(0, childReadyAt + 5300 - Date.now()))
    assert.deepEqual({
      status: settled?.status,
      cancelled: settled?.cancelled,
      resultStatus: settled?.result?.status,
      processCancelled: settled?.result?.metadata?.cancelled,
      laterEffect: await exists(later)
    }, {
      status: 'cancelled', cancelled: true, resultStatus: 'cancelled', processCancelled: true, laterEffect: false
    }, 'an accepted cancellation must survive the heartbeat and terminate its real process without false success')
  } finally {
    releaseHeartbeat()
    fs.promises.rename = originalRename
    syncBuiltinESMExports()
    if (cancellationDone) await within(cancellationDone.catch(() => {}), 5000, 'Cancellation fixture did not drain').catch(() => { cancellingChild?.kill() })
    if (taskId) {
      await BackgroundManager.cancel(taskId)
      await BackgroundManager.waitForTask(taskId, { timeoutMs: 10000, tickMs: 20 })
    }
    if (previousHome === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})
