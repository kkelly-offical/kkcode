import { createConnection, createServer } from 'node:net'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { userRootDir } from '../storage/paths.mjs'

const failure = message => Object.assign(new Error(message), { code: 'remote_control_unavailable' })
function endpointFor(root) {
  const key = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 24)
  if (process.platform === 'win32') return `\\\\.\\pipe\\kkcode-remote-${key}`
  const local = path.join(root, 'remote-control.sock')
  return Buffer.byteLength(local) < 100 ? local : path.join(os.tmpdir(), `kkcode-remote-${process.getuid?.() ?? 'user'}-${key}`, 'control.sock')
}
async function listening(endpoint) {
  return new Promise(resolve => {
    const socket = createConnection(endpoint)
    const finish = value => { socket.destroy(); resolve(value) }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(1000, () => finish(true)) // Unknown is active, never unlink.
  })
}

/** Caller holds the remote lifecycle lock. Never signal a PID from a stale file. */
export async function createRemoteControl({ root = userRootDir(), onStop = () => {}, onPair } = {}) {
  const endpoint = endpointFor(root), token = randomBytes(32).toString('base64url'), connections = new Set()
  if (process.platform !== 'win32') {
    const directory = path.dirname(endpoint)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await lstat(directory)
    if (!info.isDirectory() || process.getuid && info.uid !== process.getuid()) throw failure('Remote control directory must belong to this OS user')
    const existing = await lstat(endpoint).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (existing) {
      if (!existing.isSocket() || process.getuid && existing.uid !== process.getuid() || await listening(endpoint)) throw failure('Remote control endpoint is occupied; do not delete it while another process is active')
      await unlink(endpoint)
    }
  }
  let stopping = false
  const server = createServer(socket => {
    connections.add(socket)
    socket.on('close', () => connections.delete(socket))
    socket.on('error', () => {})
    socket.setTimeout(3000, () => socket.destroy())
    let buffer = '', handled = false
    socket.on('data', async chunk => {
      if (handled) return
      buffer += chunk.toString('utf8')
      if (Buffer.byteLength(buffer) > 1024) { handled = true; socket.destroy(); return }
      if (!buffer.includes('\n')) return
      handled = true
      let request
      try { request = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) } catch { socket.destroy(); return }
      const candidate = Buffer.from(typeof request.token === 'string' ? request.token : ''), expected = Buffer.from(token)
      if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected) || !['status', 'stop', ...(typeof onPair === 'function' ? ['pair'] : [])].includes(request.command)) { socket.end('{"ok":false}\n'); return }
      if (request.command === 'pair') socket.setTimeout(15000, () => socket.destroy())
      let extra = {}
      try { if (request.command === 'pair') extra = await onPair(request.params || {}) } catch { socket.end('{"ok":false}\n'); return }
      socket.end(JSON.stringify({ ok: true, pid: process.pid, ...extra }) + '\n', () => {
        if (request.command === 'stop' && !stopping) { stopping = true; void Promise.resolve().then(onStop).catch(() => {}) }
      })
    })
  })
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve) })
    if (process.platform !== 'win32') await chmod(endpoint, 0o600)
  } catch (error) { server.close(); throw error }
  return {
    endpoint, token,
    async close() {
      for (const socket of connections) socket.destroy()
      await new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()))
    }
  }
}

export async function requestRemoteControl({ endpoint, token }, command, { timeout = 3000, params } = {}) {
  if (typeof endpoint !== 'string' || typeof token !== 'string' || !['status', 'stop', 'pair'].includes(command)) throw failure('No authenticated local remote hub is recorded')
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let buffer = '', settled = false
    const finish = (error, result) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(result) }
    socket.once('connect', () => socket.write(JSON.stringify({ token, command, ...(params ? { params } : {}) }) + '\n'))
    socket.once('error', () => finish(failure('The recorded local remote hub is no longer reachable')))
    socket.once('end', () => { if (!settled) finish(failure('The local remote hub closed without acknowledging the request')) })
    socket.setTimeout(timeout, () => finish(failure('The local remote hub did not respond in time')))
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      if (Buffer.byteLength(buffer) > 4096) return finish(failure('Invalid local remote control response'))
      if (!buffer.includes('\n')) return
      try {
        const result = JSON.parse(buffer.slice(0, buffer.indexOf('\n')))
        if (result.ok !== true || !Number.isSafeInteger(result.pid)) throw new Error()
        finish(null, result)
      } catch { finish(failure('The local remote hub rejected the request')) }
    })
  })
}
