import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as pause } from 'node:timers/promises'
import { _android } from 'playwright-core'
import { DOMParser } from '@xmldom/xmldom'
import { loadLab } from './lab-browser.mjs'

// Unlike EnterpriseNetworkTest this uses the real native button, external
// Android Chrome tab, real lab IdP, gateway confirmation and OS return intent.
const serial = process.env.KKCODE_ANDROID_SERIAL
if (!serial || !/^emulator-\d+$/.test(serial)) throw new Error('Select the dedicated debug AVD with KKCODE_ANDROID_SERIAL')
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
if (!sdk) throw new Error('Set ANDROID_HOME')
const execute = promisify(execFile), adb = path.join(sdk, 'platform-tools/adb')
const command = async args => (await execute(adb, ['-s', serial, ...args], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout
if ((await command(['emu', 'avd', 'name'])).trim().split(/\r?\n/)[0] !== 'kkcode_101_api36') throw new Error('This smoke only uses the owned debug lab AVD')
const lab = await loadLab()
if (lab.gateway !== 'https://10.0.0.2:18472' || lab.sso !== 'https://10.0.0.2:18471') throw new Error('Refusing to submit lab credentials to a different deployment')
const connectedDevices = await _android.devices()
const device = connectedDevices.find(item => item.serial() === serial)
await Promise.all(connectedDevices.filter(item => item !== device).map(item => item.close()))
if (!device) throw new Error('The selected AVD is not connected')
const packageName = 'cn.kkcode.remote'
const restoreWifi = (await command(['shell', 'settings', 'get', 'global', 'wifi_on'])).trim() === '1'
let browser, stage = 'prepare', step = 'initialization'
async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await pause(200) }
  throw new Error(`Timed out: ${label}`)
}
const foreground = async () => (await command(['shell', 'dumpsys', 'activity', 'activities'])).split('\n')
  .some(line => /[Rr]esumedActivity/.test(line) && line.includes('cn.kkcode.remote/.MainActivity'))
async function nativeTree() {
  // A fresh UiAutomator dump also survives application process death; do not
  // hold accessibility-node handles belonging to the destroyed Activity.
  await command(['shell', 'uiautomator', 'dump', '/data/local/tmp/kkcode-login-ui.xml'])
  const xml = await command(['shell', 'cat', '/data/local/tmp/kkcode-login-ui.xml'])
  return [...new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagName('node')]
}
async function nativeNode(selector, timeout = 15000) {
  return until(async () => (await nativeTree()).find(node => node.getAttribute('package') === packageName &&
    Object.entries(selector).every(([key, value]) => node.getAttribute({ text: 'text', desc: 'content-desc', clazz: 'class' }[key] || key) === String(value))), 'native control', timeout)
}
async function nativeTap(selector, timeout) {
  const node = await nativeNode(selector, timeout)
  const bounds = node.getAttribute('bounds').match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)
  assert.ok(bounds)
  await command(['shell', 'input', 'tap', String(Math.floor((Number(bounds[1]) + Number(bounds[3])) / 2)), String(Math.floor((Number(bounds[2]) + Number(bounds[4])) / 2))])
}
async function privateLoginState() {
  // Only inspect ciphertext/key presence in this explicitly owned debug AVD.
  // Never log or export the private preferences or decoded credentials.
  const raw = await command(['shell', 'run-as', packageName, 'cat', 'shared_prefs/kkcode.secure.xml'])
  const values = [...new DOMParser().parseFromString(raw, 'text/xml').getElementsByTagName('string')]
  return { pending: values.some(node => node.getAttribute('name') === 'pending-gateway-login'), credentials: values.find(node => node.getAttribute('name') === 'credentials')?.textContent }
}
async function closeSheet() {
  if ((await nativeTree()).some(node => node.getAttribute('content-desc') === '关闭')) await nativeTap({ desc: '关闭' })
}
async function beginNativeLogin() {
  step = 'open MainActivity'
  await command(['shell', 'am', 'force-stop', packageName])
  await command(['shell', 'am', 'start', '-W', '-n', `${packageName}/.MainActivity`])
  await closeSheet()
  await pause(350)
  step = 'open more menu'
  await nativeTap({ desc: '更多' })
  step = 'choose add connection'
  await nativeTap({ text: '添加连接' })
  step = 'choose relay'
  await nativeTap({ text: 'Remote 中继' })
  if ((await nativeTree()).some(node => node.getAttribute('text') === '取消登录')) await nativeTap({ text: '取消登录' })
  await pause(350)
  step = 'enter gateway'
  const gatewayField = { clazz: 'android.widget.EditText' }
  if ((await nativeNode(gatewayField)).getAttribute('text') !== lab.gateway) {
    await nativeTap(gatewayField)
    await command(['shell', 'input', 'keycombination', '113', '29'])
    await command(['shell', 'input', 'text', lab.gateway])
  }
  assert.equal((await nativeNode(gatewayField)).getAttribute('text'), lab.gateway)
  if (/mInputShown=true/.test(await command(['shell', 'dumpsys', 'input_method']))) await command(['shell', 'input', 'keyevent', '4'])
  const previous = new Set(browser.pages())
  const before = await privateLoginState()
  step = 'click continue login'
  await nativeTap({ text: '继续登录' })
  step = 'wait for new Chrome tab'
  const page = await until(async () => browser.pages().find(page => !previous.has(page) && page.url().startsWith(`${lab.gateway}/login?`)), 'native-launched Chrome login tab')
  assert.equal((await privateLoginState()).pending, true)
  return { page, before }
}
async function authorize({ page, before }, killApp = false, manualReturn = false) {
  step = 'SSO authorization'
  await page.getByRole('button', { name: 'Continue with organization SSO' }).click()
  const screen = await until(async () => await page.locator('#username').isVisible() ? 'login' : await page.getByRole('button', { name: 'Allow this device' }).isVisible() ? 'confirm' : null, 'lab SSO screen')
  if (screen === 'login') {
    await page.locator('#username').fill(lab.credentials.accounts.owner.username)
    await page.locator('#password').fill(lab.credentials.accounts.owner.password)
    step = 'submit SSO form from the password field'
    await page.locator('#password').press('Enter')
  }
  await page.getByRole('button', { name: 'Allow this device' }).waitFor()
  if (killApp) {
    step = 'kill background App process'
    const pid = (await command(['shell', 'pidof', packageName])).trim()
    assert.match(pid, /^\d+$/)
    // Exact owned debug app PID, not force-stop (which changes intent delivery).
    await command(['shell', 'run-as', packageName, 'kill', '-9', pid])
    await until(async () => { try { return !(await command(['shell', 'pidof', packageName])).trim() } catch { return true } }, 'background process death')
  }
  if (manualReturn) {
    // Simulate a browser policy that blocks automatic script navigation. The
    // actual gateway still performs the real confirmation and emits its link.
    await page.route('**/auth/confirm', async route => {
      const response = await route.fetch()
      await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'" } })
    })
  }
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/auth/confirm')
    .then(async response => ({ status: response.status(), body: await response.text() }))
  step = 'confirm gateway grant'
  await page.getByRole('button', { name: 'Allow this device' }).click()
  const response = await responsePromise
  assert.equal(response.status, 200)
  assert.match(response.body, /cn\.kkcode\.remote:\/\/auth\/complete\?state=[A-Za-z0-9_-]{43}/)
  assert.doesNotMatch(response.body, /Open WebUI/)
  const returned = page.locator('#return-app')
  if (manualReturn) {
    step = 'click manual return'
    await returned.waitFor({ state: 'attached' })
    await pause(500); assert.equal(await foreground(), false, 'blocked automatic navigation should leave the browser visible')
    // The successful navigation leaves Chrome for an Android Activity, so it
    // has no browser document commit for Playwright to wait for.
    await returned.click({ noWaitAfter: true })
  }
  step = 'native return and profile'
  await until(foreground, 'OS return to native MainActivity', 15000)
  await until(async () => {
    const after = await privateLoginState()
    return !after.pending && after.credentials && after.credentials !== before.credentials
  }, 'new encrypted credentials committed and pending grant cleared', 30000)
  // With no online device the App opens Connections. With one it opens home.
  if (!(await nativeTree()).some(node => node.getAttribute('text') === 'KK Code Enterprise Lab')) {
    await closeSheet(); await nativeTap({ desc: '设备与连接' }); await nativeNode({ text: 'KK Code Enterprise Lab' })
  }
  await mkdir('test-results', { recursive: true })
  await writeFile(`test-results/android-login-${stage}.png`, await device.screenshot())
}

try {
  await command(['emu', 'proxy', 'clear'])
  await command(['shell', 'svc', 'wifi', 'disable'])
  browser = await device.launchBrowser({ ignoreHTTPSErrors: true, args: ['--disable-fre', '--no-default-browser-check'], proxy: { server: 'http://127.0.0.1:9', bypass: '10.0.0.2,127.0.0.1,localhost' } })
  for (const scenario of [{ name: 'warm-return' }, { name: 'process-recovery', kill: true }, { name: 'manual-fallback', manual: true }]) {
    stage = scenario.name
    console.log(`Android browser acceptance: ${stage}`)
    const page = await beginNativeLogin()
    await authorize(page, scenario.kill, scenario.manual)
    console.log(`PASS: ${stage} — native UI → Android Chrome → real SSO → gateway → native profile`)
  }
} catch (error) {
  // Never include Playwright's potentially sensitive fill/navigation call log.
  const summary = String(error.message).split('\n')[0]
    .replaceAll(lab.credentials.accounts.owner.password, '[redacted]')
    .replace(/([?&](?:state|code|session_state)=)[^\s&"']+/g, '$1[redacted]')
  throw new Error(`Android login acceptance (${stage}, ${step}): ${summary}`)
} finally {
  await browser?.close().catch(() => {})
  if (restoreWifi) await command(['shell', 'svc', 'wifi', 'enable'])
  await device.close()
}
