import { spawn } from 'node:child_process'

const checks = [
  ['scripts/web-smoke.mjs'],
  ['scripts/web-cancel-smoke.mjs'],
  ['scripts/web-conversation-smoke.mjs'],
  ['scripts/web-display-smoke.mjs'],
  ['scripts/web-history-smoke.mjs'],
  ['scripts/web-feature-contract-smoke.mjs'],
  ['scripts/web-pixel-theme-smoke.mjs'],
  ['scripts/gateway-pixel-smoke.mjs'],
  ['scripts/web-knowledge-smoke.mjs'],
  ['scripts/web-config-smoke.mjs'],
  ['scripts/web-attachments-extensions-smoke.mjs'],
  ['scripts/web-account-models-smoke.mjs'],
  ['scripts/web-drafts-smoke.mjs'],
  ['scripts/web-state-smoke.mjs'],
  // The Web CI job installs Chromium, so these contracts run rather than skip.
  ['--test',
    'test/web-memory-race.test.mjs',
    'test/web-todo-progress.test.mjs',
    'test/web-markdown-sanitization.test.mjs',
    'test/web-subagents.test.mjs',
  ],
]

for (const args of checks) {
  const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: 'inherit' })
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (exitCode, signal) => {
      if (signal) {
        process.kill(process.pid, signal)
        return
      }
      resolve(exitCode ?? 1)
    })
  })
  if (code !== 0) process.exit(code)
}
