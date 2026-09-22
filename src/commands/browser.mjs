import { Command } from 'commander'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { browserStatus } from '../kernel/index.mjs'

export function createBrowserCommand() {
  const command = new Command('browser').description('Manage the isolated built-in Browser engine')
  command.command('status').action(async () => { console.log(JSON.stringify(await browserStatus(), null, 2)) })
  command.command('install').description('Download the pinned Playwright Chromium engine for this OS user').option('--with-deps', 'Also install OS browser libraries (may require system administrator approval)').action(async options => {
    const cli = fileURLToPath(new URL('./cli.js', import.meta.resolve('playwright-core')))
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'install', ...(options.withDeps ? ['--with-deps'] : []), 'chromium'], { stdio: 'inherit', windowsHide: true })
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve(undefined) : reject(new Error(`Browser installation failed (${code}); inspect the installer output`)))
    })
    console.log('Browser engine installed. Browser actions use isolated per-conversation profiles; your personal browser is not connected.')
  })
  command.action(async () => { console.log(JSON.stringify(await browserStatus(), null, 2)) })
  return command
}
