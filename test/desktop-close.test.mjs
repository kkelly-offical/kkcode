import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { fork } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const root = fileURLToPath(new URL('../', import.meta.url))
const desktopRequire = createRequire(path.join(root, 'apps/desktop/main.cjs'))

async function waitFor(predicate, message, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function closeEvent() {
  return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
}

async function mainFixture({ active = 0, statusError = false, questionResponse = 1, onClose = () => {} } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'kkcode-desktop-main-'))
  const app = new EventEmitter()
  const dialogs = []
  let window, tray
  app.isPackaged = false
  app.quitCalls = 0
  app.setName = () => {}
  app.setPath = () => {}
  app.requestSingleInstanceLock = () => true
  app.whenReady = () => Promise.resolve()
  app.getPath = () => directory
  app.getVersion = () => '1.0.13'
  app.quit = () => {
    app.quitCalls += 1
    app.finalBeforeQuit = closeEvent()
    app.emit('before-quit', app.finalBeforeQuit)
    if (!app.finalBeforeQuit.defaultPrevented && window) {
      app.finalWindowClose = closeEvent()
      window.emit('close', app.finalWindowClose)
    }
  }

  class TestWindow extends EventEmitter {
    constructor() {
      super()
      this.webContents = new EventEmitter()
      this.webContents.setWindowOpenHandler = () => {}
      this.webContents.executeJavaScript = async () => {}
      this.hidden = false
    }
    setMenu() {}
    async loadFile() {}
    async loadURL() {}
    isDestroyed() { return false }
    isMinimized() { return false }
    show() { this.hidden = false }
    hide() { this.hidden = true }
    restore() {}
    focus() {}
  }

  class TestTray extends EventEmitter {
    setToolTip() {}
    setContextMenu() {}
    destroy() { this.destroyed = true }
  }

  const backend = new EventEmitter()
  backend.stderr = new EventEmitter()
  backend.connected = true
  backend.exitCode = null
  backend.sent = []
  const exitBackend = (code = 0) => {
    backend.exitCode = code
    backend.connected = false
    backend.emit('exit', code)
  }
  backend.send = message => {
    backend.sent.push(message)
    if (message.type === 'status') {
      queueMicrotask(() => backend.emit('message', statusError ? { id: message.id, error: 'status unavailable' } : { id: message.id, result: { active } }))
    } else if (message.type === 'close') onClose(message, { backend, exitBackend })
  }

  const electron = {
    app,
    BrowserWindow: class extends TestWindow {
      constructor() { super(); window = this }
    },
    Menu: {
      buildFromTemplate: template => ({ template, popup() {} }),
      setApplicationMenu: () => {},
    },
    Tray: class extends TestTray {
      constructor() { super(); tray = this }
    },
    nativeImage: { createFromPath: () => ({}) },
    nativeTheme: {},
    dialog: {
      showMessageBox: async (...args) => {
        const options = args.at(-1)
        dialogs.push(options)
        return { response: options.type === 'question' ? questionResponse : 0 }
      },
      showErrorBox: () => {},
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    ipcMain: { handle: () => {} },
    shell: { openExternal: async () => {} },
    clipboard: { writeText: async () => {} },
    session: { defaultSession: {
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: () => {},
      protocol: { handle: async () => {} },
    } },
    net: { fetch: async () => { throw new Error('Unexpected network request') } },
  }
  const spawn = () => {
    queueMicrotask(() => backend.emit('message', { type: 'ready', url: 'http://127.0.0.1:43123/' }))
    return backend
  }
  const filename = path.join(root, 'apps/desktop/main.cjs')
  const context = vm.createContext({
    require: id => id === 'electron' ? electron : id === 'node:child_process' ? { spawn } : desktopRequire(id),
    __dirname: path.dirname(filename),
    __filename: filename,
    module: { exports: {} },
    exports: {},
    process,
    console,
    URL,
    Response,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  })
  vm.runInContext(await readFile(filename, 'utf8'), context, { filename })
  await waitFor(() => window?.listenerCount('close') === 1 && tray, 'Desktop main did not initialize')
  return {
    app,
    backend,
    dialogs,
    get tray() { return tray },
    exitBackend,
    closeWindow() { const event = closeEvent(); window.emit('close', event); return event },
    emitBeforeQuit() { const event = closeEvent(); app.emit('before-quit', event); return event },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}

test('desktop repeated close remains blocked until graceful backend exit completes', async () => {
  let closeRequests = 0
  const fixture = await mainFixture({ active: 1, onClose: () => { closeRequests += 1 } })
  try {
    const first = fixture.closeWindow()
    await waitFor(() => closeRequests === 1, 'Initial close request was not sent')
    assert.equal(first.defaultPrevented, true)
    const repeated = fixture.closeWindow()
    const beforeQuit = fixture.emitBeforeQuit()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(repeated.defaultPrevented, true)
    assert.equal(beforeQuit.defaultPrevented, true)
    assert.equal(closeRequests, 1)
    assert.equal(fixture.app.quitCalls, 0)
    fixture.exitBackend()
    await waitFor(() => fixture.app.quitCalls === 1, 'Final quit did not run after backend exit')
    assert.equal(fixture.app.finalBeforeQuit.defaultPrevented, false)
    assert.equal(fixture.app.finalWindowClose.defaultPrevented, false)
    assert.equal(fixture.tray.destroyed, true)
    assert.equal(fixture.dialogs.some(item => item.title === '本机服务已停止'), false)
  } finally { await fixture.cleanup() }
})

test('desktop close failure is reported and a later close can finish', async () => {
  let closeRequests = 0
  const fixture = await mainFixture({ onClose: (message, { backend, exitBackend }) => {
    closeRequests += 1
    if (closeRequests === 1) queueMicrotask(() => backend.emit('message', { id: message.id, error: 'fixture close failed' }))
    else queueMicrotask(() => exitBackend())
  } })
  try {
    fixture.closeWindow()
    await waitFor(() => fixture.dialogs.some(item => item.title === '未能退出'), 'Close failure was not reported')
    await new Promise(resolve => setTimeout(resolve, 0))
    const failure = fixture.dialogs.find(item => item.title === '未能退出')
    assert.equal(failure.type, 'error')
    assert.match(failure.detail, /fixture close failed/)
    assert.equal(fixture.app.quitCalls, 0)
    assert.equal(fixture.backend.exitCode, null)
    fixture.closeWindow()
    await waitFor(() => fixture.app.quitCalls === 1, 'Retry after close failure did not quit')
    assert.equal(closeRequests, 2)
    assert.equal(fixture.app.finalBeforeQuit.defaultPrevented, false)
    assert.equal(fixture.app.finalWindowClose.defaultPrevented, false)
  } finally { await fixture.cleanup() }
})

test('desktop unknown task state never closes the backend when the user returns', async () => {
  const fixture = await mainFixture({ statusError: true, questionResponse: 2 })
  try {
    const event = fixture.closeWindow()
    await waitFor(() => fixture.dialogs.some(item => item.type === 'question'), 'Unknown task state did not prompt')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(event.defaultPrevented, true)
    assert.match(fixture.dialogs.find(item => item.type === 'question').message, /暂时无法确认/)
    assert.equal(fixture.backend.sent.some(message => message.type === 'close'), false)
    assert.equal(fixture.app.quitCalls, 0)
    assert.equal(fixture.backend.exitCode, null)
  } finally { await fixture.cleanup() }
})

test('desktop backend reports a close failure and permits a successful retry', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kkcode-desktop-backend-'))
  const fixtureRoot = path.join(directory, 'fixture')
  await mkdir(path.join(fixtureRoot, 'src/device'), { recursive: true })
  await writeFile(path.join(fixtureRoot, 'src/device/server.mjs'), `
    let closeCalls = 0
    export async function createDeviceServer() {
      return {
        device: { turns: new Map(), roots: [] },
        async listen() { return { url: 'http://127.0.0.1:43124/' } },
        async close() {
          closeCalls += 1
          process.send?.({ type: 'fixture-close', count: closeCalls })
          if (closeCalls === 1) throw new Error('fixture close failed')
        },
      }
    }
  `)
  await writeFile(path.join(fixtureRoot, 'src/device/files.mjs'), 'export async function resolveDevicePath(value) { return value }\n')
  const child = fork(path.join(root, 'apps/desktop/backend.mjs'), [fixtureRoot], { env: { ...process.env, KKCODE_HOME: path.join(directory, 'private'), KKCODE_DESKTOP_ROOTS: '[]' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let errors = ''
  const messages = []
  child.stderr.on('data', data => { errors += data.toString() })
  child.on('message', message => messages.push(message))
  const exited = new Promise(resolve => child.once('exit', resolve))
  const response = id => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Desktop response timeout: ${errors.slice(-1000)}`)) }, 3000)
    const onMessage = message => { if (message.id === id) { cleanup(); resolve(message) } }
    const onExit = code => { cleanup(); reject(new Error(`Backend exited (${code}): ${errors.slice(-1000)}`)) }
    function cleanup() { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit) }
    child.on('message', onMessage)
    child.once('exit', onExit)
  })
  try {
    await waitFor(() => messages.some(message => message.type === 'ready'), `Backend did not start: ${errors.slice(-1000)}`)
    const firstResponse = response('first')
    child.send({ id: 'first', type: 'close' })
    const failure = await firstResponse
    assert.equal(failure.error, 'fixture close failed')
    assert.equal(child.exitCode, null)
    child.send({ id: 'second', type: 'close' })
    await waitFor(() => child.exitCode !== null, `Backend retry did not exit: ${errors.slice(-1000)}`)
    assert.equal(child.exitCode, 0)
    assert.deepEqual(messages.filter(message => message.type === 'fixture-close').map(message => message.count), [1, 2])
  } finally {
    if (child.exitCode === null) { child.kill('SIGKILL'); await exited }
    await rm(directory, { recursive: true, force: true })
  }
})
