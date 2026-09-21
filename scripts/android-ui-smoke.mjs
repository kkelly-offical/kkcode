import { access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const serial = process.env.KKCODE_ANDROID_SERIAL
if (!serial || !/^[A-Za-z0-9._:-]+$/.test(serial)) throw new Error('Set KKCODE_ANDROID_SERIAL to the explicit test emulator/device; no device is selected automatically.')
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
const adb = sdk ? path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb') : 'adb'
const apks = ['android/app/build/outputs/apk/debug/app-debug.apk', 'android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk'].map(file => path.join(root, file))
for (const file of apks) await access(file)
function run(args, timeout = 120000) {
  const result = spawnSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout || 'ADB operation failed')
  return result.stdout
}
for (const apk of apks) {
  const output = run(['install', '-r', apk])
  if (!output.includes('Success')) throw new Error(output)
}
const output = run(['shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'cn.kkcode.remote.ConversationUiTest', 'cn.kkcode.remote.test/androidx.test.runner.AndroidJUnitRunner'])
if (!/OK \(\d+ tests\)/.test(output) || /FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed/.test(output)) throw new Error(output)
console.log(`Android ${serial}: ${output.match(/OK \(\d+ tests\)/)[0]}`)
