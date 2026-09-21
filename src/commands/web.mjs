import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createDeviceServer } from '../device/server.mjs'

export function parseWebOptions(argv) {
  const out = { port: 18271, host: '127.0.0.1', open: true }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (['-web', '--web'].includes(arg)) continue
    if (arg === '-host' || arg === '--host') out.host = '0.0.0.0'
    else if (/^-host-\d+$/.test(arg)) { out.host = '0.0.0.0'; out.port = Number(arg.slice(6)) }
    else if (arg === '--port') out.port = Number(argv[++i])
    else if (arg === '--no-open') out.open = false
    else if (arg === '--root') out.roots = [argv[++i]]
    else if (arg === '--origin') out.publicOrigin = argv[++i]
    else if (arg === '--tls-cert') out.cert = argv[++i]
    else if (arg === '--tls-key') out.key = argv[++i]
    else throw new Error(`Unknown WebUI option: ${arg}`)
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new Error('Port must be between 1 and 65535')
  return out
}
export async function runWeb(argv) {
  const options = parseWebOptions(argv)
  if (options.cert || options.key) options.https = { cert: await readFile(options.cert), key: await readFile(options.key) }
  const server = await createDeviceServer(options)
  const info = await server.listen()
  console.log(`KK Code WebUI: ${info.url}\nPair another client (5 minutes): ${info.pairingCode}\nCtrl+C stops this device service.`)
  if (options.open) {
    const [cmd, args] = process.platform === 'darwin' ? ['open', [info.url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', info.url]] : ['xdg-open', [info.url]]
    const child = spawn(cmd, args, { stdio: 'ignore' }); child.on('error', () => {}); child.unref()
  }
  const stop = () => { void server.close().then(() => process.exit(0)) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  process.once('SIGHUP', stop)
}
