import { spawn } from 'node:child_process'
import { mkdir, open, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDeviceServer } from '../device/server.mjs'
import { userRootDir } from '../storage/paths.mjs'
import { writePrivateFile } from '../storage/private-file.mjs'
import { acquireProcessLock } from '../storage/process-lock.mjs'
import { createRemoteControl, requestRemoteControl } from './local-control.mjs'
import { BackgroundManager } from '../kernel/index.mjs'
import { PACKAGE_VERSION } from '../version.mjs'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const hostRoot = () => path.join(userRootDir(), 'ssh-host')
const controlFile = () => path.join(hostRoot(), 'control.json')

async function readControl(target = controlFile()) {
  let file
  try {
    file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const info = await file.stat()
    if (!info.isFile() || info.size > 4096 || process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077))) throw new Error('SSH host control file must be a private regular file owned by this OS user')
    return JSON.parse(await file.readFile('utf8'))
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  finally { await file?.close() }
}

export async function serveSshHost({ port = 18271, allFolders = false, idleMs = 75000, service, hasBackgroundWork = async () => (await BackgroundManager.list()).some(task => ['queued', 'running', 'pending'].includes(task.status)) } = {}) {
  await mkdir(hostRoot(), { recursive: true, mode: 0o700 })
  const lock = await acquireProcessLock(path.join(hostRoot(), 'host.lock'))
  let server, control, timer, closing = false, lastActivity = Date.now(), checking = false
  let finish
  const closed = new Promise(resolve => { finish = resolve })
  async function close() {
    if (closing) return closed
    closing = true; clearInterval(timer)
    try { await control?.close(); await server?.close() }
    finally {
      const saved = await readControl().catch(() => null)
      if (saved?.token === control?.token) await unlink(controlFile()).catch(() => {})
      await lock.release(); finish()
    }
    return closed
  }
  try {
    server = await createDeviceServer({ service, port, host: '127.0.0.1', roots: [allFolders ? path.parse(os.homedir()).root : os.homedir()], onClientActivity: () => { lastActivity = Date.now() } })
    const info = await server.listen(), boundPort = Number(new URL(info.address).port)
    control = await createRemoteControl({ root: hostRoot(), onStop: close, onPair: () => {
      if (closing) throw new Error('SSH host is draining')
      lastActivity = Date.now()
      return { port: boundPort, bootstrap: server.issueNativePairing(), version: PACKAGE_VERSION, allFolders, lifetime: 'drain-on-disconnect' }
    } })
    await writePrivateFile(controlFile(), JSON.stringify({ endpoint: control.endpoint, token: control.token, version: PACKAGE_VERSION }))
    timer = setInterval(async () => {
      if (closing || checking || Date.now() - lastActivity < idleMs) return
      checking = true
      try {
        if (!server.device.turns.size && !server.device.commandSessions.size && !server.device.sessionTransitions.size && !await hasBackgroundWork()) await close()
      } catch { /* Unknown task state is not permission to interrupt work. */ }
      finally { checking = false }
    }, Math.max(50, Math.min(2000, idleMs / 3)))
    return { server, closed, close, control }
  } catch (error) { await close(); throw error }
}

export async function ensureSshHost({ port = 18271, allFolders = false } = {}) {
  const foreground = await readControl(path.join(userRootDir(), 'remote-status.json'))
  if (foreground?.control) {
    const active = await requestRemoteControl(foreground.control, 'status').catch(() => null)
    if (active) {
      if ((foreground.folderAccess === 'all') !== allFolders || !['all', 'home'].includes(foreground.folderAccess)) throw new Error('SSH folder scope must match the running remote hub; change the SSH connection folder choice before reconnecting')
      const result = await requestRemoteControl(foreground.control, 'pair', { timeout: 15000, params: { port, allFolders } })
      if (result.port !== port) throw new Error('SSH port must match the running remote hub local WebUI port')
      return result
    }
  }
  const pair = async () => {
    const saved = await readControl()
    if (!saved) return null
    const result = await requestRemoteControl(saved, 'pair').catch(error => { if (error.code === 'remote_control_unavailable') return null; throw error })
    if (result && (result.port !== port || result.allFolders !== allFolders)) throw new Error('The existing SSH host uses a different port or folder scope. Wait for its tasks to finish and disconnect its clients before changing that scope.')
    return result
  }
  const existing = await pair()
  if (existing) return existing
  await mkdir(hostRoot(), { recursive: true, mode: 0o700 })
  let startup
  for (let attempt = 0; !startup && attempt < 100; attempt++) {
    try { startup = await acquireProcessLock(path.join(hostRoot(), 'start.lock')) }
    catch (error) { if (error.code !== 'device_in_use') throw error; const other = await pair(); if (other) return other; await pause(100) }
  }
  if (!startup) throw new Error('Another SSH host startup is still in progress; reconnect shortly')
  try {
    const ready = await pair()
    if (ready) return ready
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', '--port', String(port), ...(allFolders ? ['--all-folders'] : [])], { detached: true, stdio: 'ignore', windowsHide: true })
    let failed = false
    child.on('error', () => { failed = true }); child.on('exit', code => { if (code) failed = true }); child.unref()
    for (let attempt = 0; attempt < 150; attempt++) {
      if (failed) break
      await pause(100)
      const result = await pair()
      if (result) return result
    }
    throw new Error('SSH task host could not start. Check the installed KK Code version, port and whether another WebUI/remote process already owns this user state.')
  } finally { await startup.release() }
}

export async function runSshHost(argv) {
  let port = 18271, allFolders = false, child = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--port') port = Number(argv[++index])
    else if (arg === '--all-folders') allFolders = true
    else if (arg === '--home-only' || arg === '--json') { /* explicit default / machine interface */ }
    else if (arg === '--child') child = true
    else throw new Error(`Unknown SSH host option: ${arg}`)
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH host port must be between 1 and 65535')
  if (!child) { console.log(JSON.stringify(await ensureSshHost({ port, allFolders }))); return }
  const host = await serveSshHost({ port, allFolders })
  const stop = () => { void host.close() }
  process.once('SIGTERM', stop); process.once('SIGINT', stop)
  // No PTY or stdin lifetime: an SSH transport disappearing does not stop a turn.
  await host.closed
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSshHost(process.argv.slice(2)).catch(() => { process.exitCode = 1 })
}
