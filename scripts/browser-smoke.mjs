import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const test = fileURLToPath(new URL('../test/browser-runtime.test.mjs', import.meta.url))
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--test', test], { stdio: 'inherit', env: { ...process.env, KKCODE_REQUIRE_BROWSER: '1' }, windowsHide: true })
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve(undefined) : reject(new Error('Built-in Browser acceptance failed')))
})
