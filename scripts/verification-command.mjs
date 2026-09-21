import path from 'node:path'
import { existsSync } from 'node:fs'

/** Verification passes argv directly; never let cmd reinterpret JS or paths. */
export function verificationCommand(command, args, { platform = process.platform, execPath = process.execPath, npmExecPath = process.env.npm_execpath, exists = existsSync } = {}) {
  if (platform === 'win32' && command === 'npm') {
    const candidates = [npmExecPath, path.win32.join(path.win32.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    const npm = candidates.find(file => file && /(?:^|[\\/])npm-cli\.(?:c?js)$/.test(file) && exists(file))
    if (!npm) throw new Error('Cannot locate npm-cli.js; run verification through npm run with a standard Node/npm installation')
    return { command: execPath, args: [npm, ...args], shell: false }
  }
  return { command, args: [...args], shell: false }
}
