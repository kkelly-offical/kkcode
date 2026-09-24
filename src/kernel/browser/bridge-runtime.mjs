import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, readFile, readdir, lstat, realpath, readlink, rename, rm, access } from 'node:fs/promises'
import { userRootDir } from '../../storage/paths.mjs'
import { acquireProcessLock } from '../../storage/process-lock.mjs'

export const BRIDGE_PACKAGE = '@playwright/mcp'
export const BRIDGE_VERSION = '0.0.82'
export const BRIDGE_INTEGRITY = 'sha512-OCqftfb8H4dnqm/njbTBRk3seUvUPttOlJUxCtEzXGETYOlRH5Qt3bbXIjmZIuWAxD9RF+yg1ASrPeXvm0y5cA=='
export const BRIDGE_EXTENSION_URL = 'https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm'
const fail = message => Object.assign(new Error(message), { code: 'browser_bridge_unavailable', operationNotStarted: true })
const hash = data => createHash('sha256').update(data).digest('hex')
const defaultRoot = () => path.join(userRootDir(), 'tool-runtimes', 'browser-bridge')

export function bridgeProcessEnvironment() {
  const keys = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
  return Object.fromEntries(keys.filter(key => process.env[key]).map(key => [key, process.env[key]]))
}

async function npmCli() {
  const bin = path.dirname(process.execPath)
  const candidates = [path.join(bin, 'node_modules/npm/bin/npm-cli.js'), path.resolve(bin, '../lib/node_modules/npm/bin/npm-cli.js')]
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    candidates.push(path.join(dir, 'node_modules/npm/bin/npm-cli.js'))
    try { const resolved = await realpath(path.join(dir, 'npm')); if (resolved.endsWith('npm-cli.js')) candidates.push(resolved) } catch {}
  }
  for (const candidate of candidates) { try { await access(candidate); return candidate } catch {} }
  throw fail('找不到本机 npm CLI，请安装与 Node 配套的 npm 后重试')
}

async function inventory(root) {
  const files = []
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const file = path.join(dir, name), relative = path.relative(root, file).split(path.sep).join('/'), info = await lstat(file)
      if (relative === 'kkcode-runtime.json') continue
      if (files.length > 30000) throw fail('浏览器运行包文件数量异常')
      if (info.isSymbolicLink()) {
        const target = await realpath(file), relTarget = path.relative(root, target)
        if (relTarget.startsWith('..') || path.isAbsolute(relTarget)) throw fail('浏览器运行包包含越界路径别名')
        files.push({ path: relative, symlink: await readlink(file) })
      } else if (info.isDirectory()) await walk(file)
      else if (info.isFile() && info.size <= 64 * 1024 * 1024 && info.nlink === 1) files.push({ path: relative, sha256: hash(await readFile(file)) })
      else throw fail('浏览器运行包包含异常文件')
    }
  }
  await walk(root)
  return files
}

export function validateBridgeLock(lock) {
  if (lock.lockfileVersion !== 3 || lock.packages?.['']?.dependencies?.[BRIDGE_PACKAGE] !== BRIDGE_VERSION || lock.packages?.[`node_modules/${BRIDGE_PACKAGE}`]?.integrity !== BRIDGE_INTEGRITY) throw fail('Playwright MCP 锁文件与固定发布摘要不匹配')
  for (const [name, entry] of Object.entries(lock.packages || {})) {
    if (!name) continue
    let url
    try { url = new URL(entry.resolved) } catch { throw fail('浏览器运行包依赖没有固定 registry 来源') }
    if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password || !/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity || '')) throw fail('浏览器运行包依赖来源或完整性摘要无效')
  }
}

export async function browserBridgeStatus({ rootDir = defaultRoot(), verify = true } = {}) {
  const directory = path.join(rootDir, BRIDGE_VERSION)
  let directoryPresent = false
  try {
    const stat = await lstat(directory)
    directoryPresent = true
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('浏览器运行包目录不是独立真实目录')
    const manifest = JSON.parse(await readFile(path.join(directory, 'kkcode-runtime.json'), 'utf8'))
    const lockBytes = await readFile(path.join(directory, 'package-lock.json'))
    if (manifest.version !== BRIDGE_VERSION || manifest.integrity !== BRIDGE_INTEGRITY || manifest.lockHash !== hash(lockBytes)) throw fail('浏览器运行包清单校验失败，请重新审查安装')
    validateBridgeLock(JSON.parse(lockBytes.toString()))
    if (verify && JSON.stringify(await inventory(directory)) !== JSON.stringify(manifest.files)) throw fail('浏览器运行包内容已变化，已拒绝加载')
    return { installed: true, version: BRIDGE_VERSION, directory, cli: path.join(directory, 'node_modules/@playwright/mcp/cli.js'), extensionUrl: BRIDGE_EXTENSION_URL }
  } catch (error) {
    if (error.code === 'ENOENT' && !directoryPresent) return { installed: false, version: BRIDGE_VERSION, extensionUrl: BRIDGE_EXTENSION_URL, setup: 'kkcode browser bridge install' }
    if (error.code === 'browser_bridge_unavailable') throw error
    throw fail('浏览器运行包存在但清单、依赖或目录无法校验；已拒绝启动和自动覆盖，请在本机保留目录检查')
  }
}

/** Explicit host installation only. No project boot install, npx latest, user
 * npm settings, lifecycle scripts, or silent package updates. */
/** @param {{rootDir?: string, signal?: AbortSignal, onProgress?: (message:string)=>void}} [options] */
export async function installBrowserBridge({ rootDir = defaultRoot(), signal, onProgress = () => {} } = {}) {
  await mkdir(rootDir, { recursive: true, mode: 0o700 })
  const lock = await acquireProcessLock(path.join(rootDir, 'install.lock'))
  let stage
  try {
    const existing = await browserBridgeStatus({ rootDir })
    if (existing.installed) return existing
    stage = await mkdtemp(path.join(rootDir, '.install-'))
    const emptyConfig = path.join(stage, 'empty-user.npmrc'), globalConfig = path.join(stage, 'empty-global.npmrc')
    await writeFile(emptyConfig, '', { mode: 0o600 }); await writeFile(globalConfig, '', { mode: 0o600 })
    await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'kkcode-browser-bridge-runtime', private: true, version: '1.0.0', dependencies: { [BRIDGE_PACKAGE]: BRIDGE_VERSION } }), { mode: 0o600 })
    const cli = await npmCli()
    onProgress(`正在安装固定浏览器桥接运行包 ${BRIDGE_VERSION}（禁用生命周期脚本）`)
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--package-lock=true', '--registry=https://registry.npmjs.org', `--cache=${path.join(rootDir, 'download-cache')}`, `--userconfig=${emptyConfig}`, `--globalconfig=${globalConfig}`, '--loglevel=error'], {
        cwd: stage, env: bridgeProcessEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal
      })
      const timer = setTimeout(() => child.kill('SIGKILL'), 180000)
      let bytes = 0
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { bytes += data.length; if (bytes > 4 * 1024 * 1024) child.kill('SIGKILL') })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve(undefined) : reject(fail('浏览器运行包安装未成功；没有启用部分安装的工具包')) })
    })
    signal?.throwIfAborted()
    const lockBytes = await readFile(path.join(stage, 'package-lock.json'))
    validateBridgeLock(JSON.parse(lockBytes.toString()))
    const manifest = { version: BRIDGE_VERSION, integrity: BRIDGE_INTEGRITY, lockHash: hash(lockBytes), files: await inventory(stage), installedAt: Date.now(), installationId: randomUUID() }
    await writeFile(path.join(stage, 'kkcode-runtime.json'), JSON.stringify(manifest), { mode: 0o600 })
    await rename(stage, path.join(rootDir, BRIDGE_VERSION)); stage = null
    return browserBridgeStatus({ rootDir })
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true })
    await lock.release()
  }
}
