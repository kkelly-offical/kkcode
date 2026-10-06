import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { _electron as electron, expect } from '@playwright/test'
import { gatewayFixture } from './desktop-gateway-fixture.mjs'

if (process.platform !== 'win32') throw new Error('Windows application acceptance must run on Windows')
const root = path.resolve('.'), output = path.join(root, 'test-results/windows-release')
const { version } = JSON.parse(await readFile('package.json', 'utf8'))
const installer = path.join(output, `kkcode-windows-${version}-x64-setup.exe`)
await access(installer)
const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'kkcode-windows-')))
const installed = path.join(temporary, 'app')
function run(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 180000, windowsHide: true })
  assert.equal(result.status, 0, `${path.basename(file)} failed: ${result.stderr || result.error?.message || result.stdout}`)
  return result.stdout
}
run(installer, ['/S', `/D=${installed}`])
const executablePath = path.join(installed, 'KK Code.exe')
await access(executablePath)
const runtime = path.join(installed, 'resources', 'runtime')
const target = JSON.parse(await readFile('configs/desktop-release.json', 'utf8'))
assert.equal(run(path.join(runtime, 'node', 'node.exe'), ['--version']).trim(), `v${target.nodeVersion}`)
assert.match(run(path.join(runtime, 'search', 'rg.exe'), ['--version']), new RegExp(`ripgrep ${target.ripgrepVersion.replaceAll('.', '\\.')}`))
let app, data, marker, gateway
const errors = []
try {
  app = await electron.launch({ executablePath, timeout: 60000 })
  const page = await app.firstWindow({ timeout: 60000 })
  page.on('pageerror', error => errors.push(error.message))
  await expect(page.locator('.app')).toBeVisible({ timeout: 60000 })
  assert.equal(new URL(page.url()).hostname, '127.0.0.1')
  const security = await app.evaluate(({ BrowserWindow, app }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
    return { nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation, sandbox: preferences.sandbox, version: app.getVersion(), data: app.getPath('userData') }
  })
  assert.equal(security.nodeIntegration, false); assert.equal(security.contextIsolation, true); assert.equal(security.sandbox, true); assert.equal(security.version, version)
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
  await expect(page.getByRole('navigation', { name: '桌面工作区' })).toBeVisible()
  await app.evaluate(({ Menu, shell }) => {
    globalThis.fixtureExternalLinks = []
    const build = Menu.buildFromTemplate.bind(Menu)
    globalThis.fixtureOriginalMenuBuild = build
    globalThis.fixtureOriginalOpenExternal = shell.openExternal
    shell.openExternal = async url => { globalThis.fixtureExternalLinks.push(url) }
    Menu.buildFromTemplate = template => {
      if (template.some(item => item.label === '在系统浏览器中打开链接')) { globalThis.fixtureLinkMenu = template; return { popup() {} } }
      return build(template)
    }
  })
  await page.evaluate(() => { const a = document.createElement('a'); a.id = 'native-link-fixture'; a.href = 'https://example.invalid/auth'; a.textContent = '授权链接测试'; a.style = 'position:fixed;top:10px;right:10px;z-index:99999'; document.body.append(a) })
  await page.locator('#native-link-fixture').click({ button: 'right' })
  const linkMenu = await app.evaluate(async ({ Menu, shell, clipboard }) => {
    const items = globalThis.fixtureLinkMenu
    await items.find(item => item.label === '在系统浏览器中打开链接').click()
    await items.find(item => item.label === '复制链接地址').click()
    const result = { links: globalThis.fixtureExternalLinks, copied: await clipboard.readText() }
    Menu.buildFromTemplate = globalThis.fixtureOriginalMenuBuild; shell.openExternal = globalThis.fixtureOriginalOpenExternal
    return result
  })
  assert.deepEqual(linkMenu, { links: ['https://example.invalid/auth'], copied: 'https://example.invalid/auth' })
  await page.locator('#native-link-fixture').evaluate(element => element.remove())
  data = security.data; marker = path.join(data, 'upgrade-retention-smoke.txt')
  await writeFile(marker, 'retain-user-state')
  const project = path.join(temporary, 'project')
  const { mkdir } = await import('node:fs/promises'); await mkdir(project)
  await app.evaluate(({ dialog }, chosen) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] }) }, project)
  await page.getByRole('button', { name: '选择项目与工作区', exact: true }).click()
  await page.getByRole('button', { name: '选择其他文件夹', exact: false }).click()
  await expect(page.getByRole('button', { name: '选择项目与工作区', exact: true })).toHaveAttribute('title', project)
  const pasteFile = path.join(project, 'clipboard-notes.txt')
  await writeFile(pasteFile, 'Desktop clipboard file acceptance')
  const secondPasteFile = path.join(project, 'clipboard-second.txt')
  await writeFile(secondPasteFile, 'Second file in the same conversation')
  const pasteScript = path.join(temporary, 'clipboard-files.ps1')
  await writeFile(pasteScript, `Add-Type -AssemblyName System.Windows.Forms\n$clipboardFiles = New-Object System.Collections.Specialized.StringCollection\n[void]$clipboardFiles.Add('${pasteFile.replaceAll("'", "''")}')\n[void]$clipboardFiles.Add('${secondPasteFile.replaceAll("'", "''")}')\n[System.Windows.Forms.Clipboard]::SetFileDropList($clipboardFiles)\n`)
  run('powershell.exe', ['-NoProfile', '-STA', '-File', pasteScript])
  const composer = page.getByRole('textbox', { name: '消息', exact: true })
  await composer.focus(); await composer.press('Control+V')
  await expect(page.getByRole('button', { name: '移除附件 clipboard-second.txt', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '移除附件 clipboard-notes.txt', exact: true })).toBeEnabled()
  await expect(page.locator('.composer-attachment')).toHaveCount(2)
  await page.getByRole('button', { name: '移除附件 clipboard-notes.txt', exact: true }).click()
  await page.getByRole('button', { name: '移除附件 clipboard-second.txt', exact: true }).click()
  await expect(page.locator('.composer-attachment')).toHaveCount(0)
  const denied = await page.evaluate(async () => { try { await window.kkcodeDesktop.connectGateway('javascript:alert(1)'); return false } catch { return true } })
  assert.equal(denied, true)
  await page.evaluate(() => window.kkcodeDesktop.savePreferences({ 'kkcode.web.theme': 'light', 'kkcode.web.reading': '{"scale":125,"width":"wide"}' }))
  await page.screenshot({ path: path.join(output, 'windows-installed.png') })
  gateway = await gatewayFixture(temporary)
  // Trust only this freshly generated loopback certificate in this test
  // session. All other hosts continue through Chromium's verification.
  await app.evaluate(({ session }, pem) => {
    session.defaultSession.setCertificateVerifyProc((request, callback) => callback(request.hostname === '127.0.0.1' && request.certificate.data.replace(/\s/g, '') === pem.replace(/\s/g, '') ? 0 : -3))
  }, gateway.certificate)
  await page.evaluate(origin => { void window.kkcodeDesktop.connectGateway(origin) }, gateway.origin)
  await page.waitForURL(gateway.origin + '/')
  await expect(page.locator('.app')).toBeVisible()
  assert.equal(await page.evaluate(() => typeof window.kkcodeDesktop), 'undefined')
  assert.equal(await page.evaluate(() => typeof window.kkcodeDesktopLogin), 'object')
  const loginState = 'd'.repeat(43)
  await page.evaluate(state => window.kkcodeDesktopLogin.prepare(state), loginState)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
  run('cmd.exe', ['/c', 'start', '', `cn.kkcode.desktop://auth/complete?state=${loginState}`])
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), { timeout: 15000 }).toBe(true)
  await expect(page.locator('body')).not.toContainText('OLD GATEWAY UI')
  const transport = await page.evaluate(async () => {
    const post = await (await fetch('/auth/fixture', { method: 'POST', body: 'fixture-body' })).json()
    const cookie = await (await fetch('/api/v1/fixture-cookie')).json()
    const response = await fetch('/api/v1/fixture-stream'), reader = response.body.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    let rest = ''
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; rest += new TextDecoder().decode(chunk.value) }
    return { post, cookie, first, rest }
  })
  assert.deepEqual(transport.post, { method: 'POST', body: 'fixture-body' })
  assert.match(transport.cookie.cookie, /fixture=allowed/)
  assert.match(transport.first, /data: first/); assert.match(transport.rest, /data: second/)
  assert.ok(gateway.seen.includes('/api/v1/discovery'))
  assert.equal(gateway.seen.includes('/'), false, 'The Windows client must keep its bundled UI when connecting an older gateway')
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === '返回本机').click())
  await expect(page.locator('.app')).toBeVisible()
  await expect.poll(() => page.evaluate(() => typeof window.kkcodeDesktop)).toBe('object')
  await app.evaluate(({ session }) => session.defaultSession.setCertificateVerifyProc(null))
  await gateway.close(); gateway = null
  assert.deepEqual(errors, [])
  await app.close(); app = null
  app = await electron.launch({ executablePath, timeout: 60000 })
  const reopened = await app.firstWindow({ timeout: 60000 })
  await expect(reopened.locator('.app')).toBeVisible({ timeout: 60000 })
  await expect(reopened.locator('html')).toHaveAttribute('data-theme', 'light')
  assert.equal(await reopened.evaluate(() => JSON.parse(localStorage.getItem('kkcode.web.reading')).scale), 125)
  await app.close(); app = null
  // Reinstall the same signed/unsigned candidate to verify installer state retention.
  run(installer, ['/S', `/D=${installed}`])
  assert.equal(await readFile(marker, 'utf8'), 'retain-user-state')
  const uninstaller = (await readdir(installed)).find(file => /^Uninstall.*\.exe$/i.test(file))
  assert.ok(uninstaller)
  run(path.join(installed, uninstaller), ['/S'])
  assert.equal(await readFile(marker, 'utf8'), 'retain-user-state')
  const report = { version, platform: 'win32', arch: 'x64', installer: path.basename(installer), sha256: createHash('sha256').update(await readFile(installer)).digest('hex'), installedLaunch: true, projectPicker: true, sandbox: true, contextIsolation: true, bundledGatewayUi: true, gatewayPostCookiesAndStreaming: true, remoteNativeBridgeAbsent: true, nativeLinkContextMenu: true, systemProtocolLoginReturn: true, nativeClipboardFile: true, desktopWorkspaceRail: true, displayPreferencesAfterRestart: true, retainedAfterReinstall: true, retainedAfterUninstall: true, modelCalls: 0, errors }
  await writeFile(path.join(output, 'windows-verification.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally { if (app) await app.close(); if (gateway) await gateway.close() }
