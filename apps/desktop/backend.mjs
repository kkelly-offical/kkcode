import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'

// A separate Node runtime owns the agent. Renderer content never receives its IPC channel.
const root = path.resolve(process.argv[2] || fileURLToPath(new URL('../../', import.meta.url)))
const { createDeviceServer } = await import(pathToFileURL(path.join(root, 'src/device/server.mjs')).href)
const { resolveDevicePath } = await import(pathToFileURL(path.join(root, 'src/device/files.mjs')).href)
const roots = JSON.parse(process.env.KKCODE_DESKTOP_ROOTS || '[]')
const server = await createDeviceServer({ port: 0, host: '127.0.0.1', cwd: roots[0] || os.homedir(), roots: [...new Set([os.homedir(), ...roots])] })
const info = await server.listen()
process.send?.({ type: 'ready', url: info.url })
let closing = false
async function close() {
  if (closing) return
  closing = true
  await server.close()
  process.exitCode = 0
  process.disconnect?.()
}
process.on('message', async message => {
  if (!message || typeof message.id !== 'string') return
  try {
    let result
    if (message.type === 'status') result = { active: server.device.turns.size }
    else if (message.type === 'allow-root' && typeof message.path === 'string') {
      const folder = await resolveDevicePath(message.path, [message.path], { directory: true })
      server.device.roots = [...new Set([...server.device.roots, folder])]
      result = { path: folder }
    } else if (message.type === 'close') { await close(); return }
    else throw new Error('Unsupported desktop operation')
    process.send?.({ id: message.id, result })
  } catch (error) { process.send?.({ id: message.id, error: error.message }) }
})
process.once('disconnect', () => { void close().catch(() => { process.exitCode = 1 }) })
process.once('SIGTERM', () => { void close() })
