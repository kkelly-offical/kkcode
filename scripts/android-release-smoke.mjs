import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)))
const serial = process.env.KKCODE_ANDROID_SERIAL
if (!serial || !/^emulator-\d+$/.test(serial)) throw new Error('Select the dedicated release acceptance emulator explicitly with KKCODE_ANDROID_SERIAL')
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
if (!sdk) throw new Error('Set ANDROID_HOME or ANDROID_SDK_ROOT')
const adb = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
function run(args, options = {}) {
  const result = spawnSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...options })
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout || 'ADB operation failed')
  return result.stdout
}
const name = run(['emu', 'avd', 'name']).trim().split(/\r?\n/)[0]
if (name !== 'kkcode_101_release_api36') throw new Error('Refusing to install over another emulator/application identity; use the isolated release AVD')
if (run(['shell', 'getprop', 'sys.boot_completed']).trim() !== '1') throw new Error('Wait for the release AVD to finish booting')
const apk = path.join(root, 'android/app/build/outputs/apk/release/app-release.apk')
if (!run(['install', '-r', apk]).includes('Success')) throw new Error('Release APK installation did not succeed')
const packageInfo = run(['shell', 'dumpsys', 'package', 'cn.kkcode.remote'])
if (!packageInfo.includes('versionName=1.0.1') || /^\s*flags=.*DEBUGGABLE/m.test(packageInfo)) throw new Error('Installed package is not a non-debuggable 1.0.1 release')
run(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'])
run(['shell', 'wm', 'dismiss-keyguard'])
run(['shell', 'am', 'start', '-W', '-n', 'cn.kkcode.remote/.MainActivity'])
await setTimeout(2500)
if (!/^\d+(?:\s+\d+)*$/.test(run(['shell', 'pidof', 'cn.kkcode.remote']).trim())) throw new Error('Release process exited after launch')
const hierarchy = `/sdcard/kkcode-release-acceptance-${randomUUID()}.xml`
let xml = ''
try {
  run(['shell', 'uiautomator', 'dump', hierarchy])
  xml = run(['exec-out', 'cat', hierarchy])
} finally { run(['shell', 'rm', hierarchy]) }
if (!xml.includes('你的对话，在这里继续') || xml.includes('网关地址') || xml.includes('API Key')) throw new Error('Release startup is not the expected compact, unconfigured home')
const access = spawnSync(adb, ['-s', serial, 'shell', 'run-as', 'cn.kkcode.remote', 'id'], { encoding: 'utf8', timeout: 10000 })
if (access.status === 0 || !`${access.stdout}${access.stderr}`.includes('not debuggable')) throw new Error('Release unexpectedly permits run-as debugging')
await mkdir(path.join(root, 'test-results'), { recursive: true })
await writeFile(path.join(root, 'test-results/android-release-home.png'), run(['exec-out', 'screencap', '-p'], { encoding: null }))
console.log(`Android ${serial}: signed release installed; process alive; compact home; no configuration form; run-as rejected`)
