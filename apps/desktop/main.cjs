'use strict'
const { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, dialog, ipcMain, shell, session, net } = require('electron')
const { spawn } = require('node:child_process')
const { readFile, readdir, mkdir, writeFile, rename } = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { randomUUID } = require('node:crypto')
const { gatewayOrigin, externalUrl, trustedFrame, uiPreferences, bundledGatewayAsset } = require('./policy.cjs')

app.setName('KK Code')
if (!app.isPackaged && process.env.KKCODE_DESKTOP_TEST_USER_DATA) app.setPath('userData', process.env.KKCODE_DESKTOP_TEST_USER_DATA)
const locked = app.requestSingleInstanceLock()
if (!locked) app.quit()
let window, gatewayDialog, tray, backend, localUrl = '', localOrigin = '', quitting = false, closePending = false
let preferences = { roots: [], gateway: '', ui: {} }, saving = Promise.resolve()
const pending = new Map(), allowedOrigins = new Set(), gatewayOrigins = new Set()
const iconPath = path.join(__dirname, 'icon.png')
const settingsFile = () => path.join(app.getPath('userData'), 'desktop.json')
function save() {
  const snapshot = JSON.stringify(preferences, null, 2)
  saving = saving.catch(() => {}).then(async () => {
    await mkdir(app.getPath('userData'), { recursive: true })
    const temporary = `${settingsFile()}.${randomUUID()}.tmp`
    await writeFile(temporary, snapshot, { mode: 0o600 })
    await rename(temporary, settingsFile())
  })
  return saving
}
function workerRequest(type, params = {}) {
  if (!backend?.connected) return Promise.reject(new Error('本机服务尚未就绪'))
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('本机服务暂未响应，请稍后重试')) }, 15000)
    pending.set(id, { resolve, reject, timer }); backend.send({ id, type, ...params })
  })
}
async function startBackend() {
  const runtime = app.isPackaged ? path.join(process.resourcesPath, 'runtime') : null
  const node = runtime ? path.join(runtime, 'node', 'node.exe') : process.env.KKCODE_DESKTOP_NODE || 'node'
  const root = runtime ? path.join(runtime, 'agent', 'node_modules', '@kkelly-offical', 'kkcode') : path.resolve(__dirname, '../..')
  const script = runtime ? path.join(runtime, 'backend.mjs') : path.join(__dirname, 'backend.mjs')
  const data = path.join(app.getPath('userData'), 'agent')
  await mkdir(data, { recursive: true, mode: 0o700 })
  const env = { ...process.env, KKCODE_HOME: data, KKCODE_DESKTOP_ROOTS: JSON.stringify(preferences.roots) }
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS
  if (runtime) {
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH'
    env[pathKey] = [path.join(runtime, 'node'), path.join(runtime, 'search'), env[pathKey] || ''].join(path.delimiter)
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('本机服务启动超时')), 30000)
    backend = spawn(node, [script, root], { cwd: os.homedir(), env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    // Backend diagnostics remain local; bootstrap/session secrets never enter logs.
    backend.stderr.on('data', () => {})
    backend.on('error', error => { clearTimeout(timer); reject(error) })
    backend.on('message', message => {
      if (message?.type === 'ready' && typeof message.url === 'string') {
        const parsed = new URL(message.url)
        if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') { clearTimeout(timer); reject(new Error('本机服务返回了无效地址')); return }
        localUrl = parsed.href; localOrigin = parsed.origin; allowedOrigins.add(localOrigin)
        clearTimeout(timer); resolve(localUrl); return
      }
      const request = pending.get(message?.id)
      if (request) { clearTimeout(request.timer); pending.delete(message.id); message.error ? request.reject(new Error(message.error)) : request.resolve(message.result) }
    })
    backend.on('exit', code => {
      clearTimeout(timer)
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('本机服务已停止')) }
      pending.clear()
      if (!localUrl) reject(new Error(`本机服务无法启动（${code ?? 'unknown'}）`))
      else if (!quitting) void dialog.showMessageBox({ type: 'error', title: '本机服务已停止', message: '请重新打开 KK Code。已有会话记录会保留；重新执行前请确认上一项操作的状态。' })
    })
  })
}
function showWindow() { if (!window || window.isDestroyed()) return; window.show(); if (window.isMinimized()) window.restore(); window.focus() }
function openExternal(value) { const url = externalUrl(value); if (url) void shell.openExternal(url) }
async function useGateway(value) {
  const origin = gatewayOrigin(value)
  allowedOrigins.add(origin); gatewayOrigins.add(origin); preferences.gateway = origin; await save()
  await window.loadURL(origin)
}
async function chooseFolder() {
  const result = await dialog.showOpenDialog(window, { title: '选择项目文件夹', properties: ['openDirectory'], defaultPath: preferences.roots.at(-1) || os.homedir() })
  if (result.canceled || !result.filePaths[0]) return null
  const approved = await workerRequest('allow-root', { path: result.filePaths[0] })
  preferences.roots = [...new Set([...preferences.roots, approved.path])].slice(-100); await save()
  return approved.path
}
function showGatewayDialog() {
  if (gatewayDialog && !gatewayDialog.isDestroyed()) { gatewayDialog.focus(); return }
  gatewayDialog = new BrowserWindow({ parent: window, modal: true, width: 520, height: 520, resizable: false, title: '连接企业网关', backgroundColor: '#0d1311', icon: iconPath,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, additionalArguments: ['--kkcode-gateway-dialog'] } })
  gatewayDialog.setMenu(null)
  gatewayDialog.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  gatewayDialog.webContents.on('will-navigate', event => event.preventDefault())
  void gatewayDialog.loadFile(path.join(__dirname, 'gateway.html'))
  gatewayDialog.on('closed', () => { gatewayDialog = null })
}
async function quitSafely() {
  if (quitting || closePending) return
  closePending = true
  try {
    const { active } = await workerRequest('status').catch(() => ({ active: -1 }))
    if (active !== 0) {
      const answer = await dialog.showMessageBox(window, { type: 'question', title: '退出 KK Code', message: active > 0 ? `还有 ${active} 个本机任务正在执行。` : '暂时无法确认本机任务状态。', detail: '后台运行会保留本机任务。停止并退出不会撤销已经发生的改动；远程设备上的任务不受影响。', buttons: ['后台运行', '停止并退出', '返回'], defaultId: 0, cancelId: 2, noLink: true })
      if (answer.response === 0) { window.hide(); return }
      if (answer.response !== 1) return
    }
    quitting = true
    if (backend?.connected) {
      await new Promise(resolve => { const timer = setTimeout(resolve, 30000); backend.once('exit', () => { clearTimeout(timer); resolve() }); backend.send({ type: 'close', id: randomUUID() }) })
      if (backend.exitCode === null) {
        quitting = false
        await dialog.showMessageBox(window, { type: 'info', title: '正在停止', message: '本机任务还在收尾，窗口会保持打开。请稍后再次退出。' })
        return
      }
    }
    await saving.catch(() => {})
    tray?.destroy(); app.quit()
  } finally { closePending = false }
}
if (locked) app.whenReady().then(async () => {
  try {
    try { const stored = JSON.parse(await readFile(settingsFile(), 'utf8')); preferences = { roots: Array.isArray(stored.roots) ? stored.roots.filter(value => typeof value === 'string' && path.isAbsolute(value)).slice(-100) : [], gateway: typeof stored.gateway === 'string' ? stored.gateway : '', ui: uiPreferences(stored.ui) } } catch { /* First launch uses local defaults. */ }
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
    nativeTheme.themeSource = preferences.ui['kkcode.web.theme'] === 'auto' ? 'system' : preferences.ui['kkcode.web.theme'] || 'dark'
    // Only this release's exact UI files are served locally. Auth, API and SSE
    // retain the selected gateway's HTTPS origin, cookies and certificate checks.
    const webRoot = app.isPackaged ? path.join(process.resourcesPath, 'runtime', 'agent', 'node_modules', '@kkelly-offical', 'kkcode', 'src', 'web') : path.resolve(__dirname, '../../src/web')
    const assets = new Map([['/', path.join(webRoot, 'index.html')], ['/index.html', path.join(webRoot, 'index.html')]])
    for (const file of await readdir(path.join(webRoot, 'assets'))) if (/^[a-zA-Z0-9_.-]+$/.test(file)) assets.set(`/assets/${file}`, path.join(webRoot, 'assets', file))
    await session.defaultSession.protocol.handle('https', async request => {
      const key = bundledGatewayAsset(request, gatewayOrigins, assets)
      if (!key) return net.fetch(request, { bypassCustomProtocolHandlers: true })
      const file = assets.get(key), body = await readFile(file)
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream'
      return new Response(body, { headers: { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
    })
    await startBackend()
    window = new BrowserWindow({ width: 1440, height: 1000, minWidth: 820, minHeight: 600, title: 'KK Code', backgroundColor: '#0d1311', icon: iconPath, show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, additionalArguments: [`--kkcode-origin=${localOrigin}`] } })
    window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' } })
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.webContents.on('will-navigate', (event, url) => {
      let origin
      try { origin = new URL(url).origin } catch { event.preventDefault(); return }
      if (!allowedOrigins.has(origin)) { event.preventDefault(); openExternal(url) }
    })
    window.webContents.on('will-redirect', (event, url) => { try { if (!allowedOrigins.has(new URL(url).origin)) event.preventDefault() } catch { event.preventDefault() } })
    window.on('close', event => { if (!quitting) { event.preventDefault(); void quitSafely() } })
    window.once('ready-to-show', showWindow)
    const localGuard = event => { if (!trustedFrame(event, window, localOrigin)) throw new Error('此操作仅供本机工作区使用') }
    ipcMain.handle('kkcode:choose-folder', async event => { localGuard(event); return chooseFolder() })
    ipcMain.handle('kkcode:connect-gateway', async (event, value) => { localGuard(event); await useGateway(value); return true })
    ipcMain.handle('kkcode:display-preferences', event => { localGuard(event); return preferences.ui })
    ipcMain.handle('kkcode:save-display-preferences', async (event, value) => { localGuard(event); preferences.ui = uiPreferences(value); nativeTheme.themeSource = preferences.ui['kkcode.web.theme'] === 'auto' ? 'system' : preferences.ui['kkcode.web.theme'] || 'dark'; await save(); return true })
    ipcMain.handle('kkcode:gateway-dialog-connect', async (event, value) => {
      if (!gatewayDialog || event.sender !== gatewayDialog.webContents || event.senderFrame !== gatewayDialog.webContents.mainFrame) throw new Error('无效的网关连接请求')
      await useGateway(value); gatewayDialog.close(); return true
    })
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '工作区', submenu: [
        { label: '新对话', accelerator: 'Ctrl+N', click: () => { void window.webContents.executeJavaScript("window.dispatchEvent(new Event('kkcode:new-conversation'))") } },
        { label: '搜索对话', accelerator: 'Ctrl+K', click: () => { void window.webContents.executeJavaScript("window.dispatchEvent(new Event('kkcode:search-conversations'))") } },
        { type: 'separator' },
        { label: '返回本机', accelerator: 'Ctrl+Shift+H', click: () => { void window.loadURL(localOrigin) } },
        { label: '打开项目文件夹…', accelerator: 'Ctrl+O', click: () => { void chooseFolder().then(folder => { if (folder) return window.loadURL(`${localOrigin}/#project=${encodeURIComponent(folder)}`) }).catch(error => dialog.showErrorBox('未能打开项目', error.message)) } },
        { label: '连接企业网关…', click: showGatewayDialog }, { type: 'separator' }, { label: '退出', accelerator: 'Alt+F4', click: () => { void quitSafely() } },
      ] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '视图', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { label: '帮助', submenu: [{ label: '查看新版与发行说明', click: () => openExternal('https://github.com/kkelly-offical/kkcode/releases/latest') }, { label: '关于 KK Code', click: () => { void dialog.showMessageBox(window, { title: '关于 KK Code', message: `KK Code ${app.getVersion()}`, detail: 'Windows 客户端 · 本机工作区与企业网关' }) } }] },
    ]))
    tray = new Tray(nativeImage.createFromPath(iconPath))
    tray.setToolTip('KK Code')
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 KK Code', click: showWindow }, { label: '退出', click: () => { void quitSafely() } }]))
    tray.on('double-click', showWindow)
    await window.loadURL(localUrl)
  } catch (error) { await dialog.showMessageBox({ type: 'error', title: 'KK Code 未能启动', message: error.message }); quitting = true; if (backend?.connected) backend.disconnect(); app.quit() }
})
app.on('second-instance', showWindow)
app.on('activate', showWindow)
app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void quitSafely() } })
