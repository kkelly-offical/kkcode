import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { verificationCommand } from '../scripts/verification-command.mjs'

test('Windows native Node verification receives the entire eval source as one argument', () => {
  const code = "const sdk = { value: 'a & b | c > d' }; if (!sdk || sdk.value !== 'a & b | c > d') throw new Error('split'); console.log(sdk.value)"
  const invocation = verificationCommand(process.execPath, ['--input-type=module', '-e', code], { platform: 'win32' })
  assert.equal(invocation.shell, false)
  assert.equal(invocation.args[2], code)
  const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8', shell: invocation.shell })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'a & b | c > d')
})

test('Windows npm verification launches its JavaScript entry point without cmd path expansion', () => {
  const npm = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
  const artifact = 'C:\\Users\\QA & Tools\\package file.tgz'
  const result = verificationCommand('npm', ['install', artifact], { platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe', npmExecPath: npm, exists: file => file === npm })
  assert.deepEqual(result, { command: 'C:\\Program Files\\nodejs\\node.exe', args: [npm, 'install', artifact], shell: false })
})

test('Windows npm locator supports bundled npm but never substitutes an unrelated package manager', () => {
  const npm = 'C:\\node\\node_modules\\npm\\bin\\npm-cli.js'
  const options = { platform: 'win32', execPath: 'C:\\node\\node.exe', npmExecPath: 'C:\\bin\\pnpm.cjs', exists: file => file === npm }
  assert.equal(verificationCommand('npm', ['--version'], options).args[0], npm)
  assert.throws(() => verificationCommand('npm', [], { ...options, exists: () => false }), /Cannot locate npm-cli/)
  assert.deepEqual(verificationCommand('npm', ['ci'], { platform: 'linux' }), { command: 'npm', args: ['ci'], shell: false })
})
