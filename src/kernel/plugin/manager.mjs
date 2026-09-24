import path from 'node:path'
import { mkdtemp, mkdir, readdir, readFile, cp, rename, rm, lstat, realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import pacote from 'pacote'
import { userRootDir } from '../../storage/paths.mjs'
import { readJson, writeJsonAtomic } from '../../storage/json-store.mjs'
import { acquireProcessLock } from '../../storage/process-lock.mjs'
import { inspectPluginContent, readPluginLock, writePluginLock, verifyManagedPlugin, publishPluginContent } from './integrity.mjs'

const run = promisify(execFile)
const pluginName = name => { if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(name)) throw new Error('Plugin name must use lowercase letters, numbers, - or _'); return name }
async function rejectLinks(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.name === '.git') continue
    const target = path.join(dir, item.name), info = await lstat(target)
    if (info.isSymbolicLink()) throw new Error('Portable plugins may not contain symbolic links')
    if (info.isDirectory()) await rejectLinks(target)
  }
}
export async function installPlugin({ name, source, revision, update = false }) {
  name = pluginName(name)
  if (typeof source !== 'string' || !source.trim()) throw new Error('Plugin source is required')
  const root = path.join(userRootDir(), 'plugins')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const lock = await acquireProcessLock(path.join(userRootDir(), 'plugin-locks', `${name}.install.lock`))
  const target = path.join(root, name)
  let staging, backup, oldLock = null
  try {
    staging = await mkdtemp(path.join(root, '.install-'))
    const payload = path.join(staging, 'payload')
    oldLock = await readPluginLock(name)
    let packageIntegrity = null
    if (source.startsWith('npm:')) {
      const spec = source.slice(4)
      if (!/^(?:@[a-z0-9_~-][a-z0-9._~-]*\/)?[a-z0-9_~-][a-z0-9._~-]*@\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(spec)) throw new Error('npm plugins require an exact version and a registry package name')
      const options = { ignoreScripts: true, registry: 'https://registry.npmjs.org', cache: path.join(staging, 'npm-cache') }
      const resolved = await pacote.manifest(spec, options)
      packageIntegrity = resolved._integrity || resolved.dist?.integrity
      if (typeof packageIntegrity !== 'string' || !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(packageIntegrity)) throw new Error('npm plugin has no verifiable content integrity')
      if (oldLock?.source === source && oldLock.packageIntegrity && oldLock.packageIntegrity !== packageIntegrity) throw new Error('Pinned npm version integrity changed; refusing replacement')
      await pacote.extract(spec, payload, { ...options, integrity: packageIntegrity })
    } else if (/^https:\/\/.+\.git$/.test(source)) {
      if (!/^[a-fA-F0-9]{40}$/.test(revision || '')) throw new Error('Git plugins require a full commit SHA')
      const url = new URL(source)
      if (url.username || url.password || url.search || url.hash) throw new Error('Git plugin URLs cannot contain credentials, queries or fragments')
      const env = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
      Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https', GIT_CEILING_DIRECTORIES: staging })
      const safeGit = ['-c', `core.hooksPath=${path.join(staging, 'no-hooks')}`, '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', '-c', 'protocol.ext.allow=never']
      await run('git', [...safeGit, 'clone', '--no-checkout', '--', source, payload], { cwd: staging, env, timeout: 120000 })
      await run('git', [...safeGit, 'checkout', '--detach', revision], { cwd: payload, env, timeout: 120000 })
      await rm(path.join(payload, '.git'), { recursive: true, force: true })
    } else {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) throw new Error('Unsupported plugin URL; use a pinned npm package or credential-free HTTPS Git URL')
      if ((await lstat(path.resolve(source))).isSymbolicLink()) throw new Error('Portable plugin source cannot use symbolic links')
      source = await realpath(path.resolve(source))
      await rejectLinks(path.resolve(source))
      await cp(path.resolve(source), payload, { recursive: true, filter: src => path.basename(src) !== '.git' })
    }
    await rejectLinks(payload)
    let manifest, manifestFile
    for (const candidate of ['plugin.json', '.kkcode-plugin/plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
      try { manifest = JSON.parse(await readFile(path.join(payload, candidate), 'utf8')); manifestFile = candidate; break } catch { /* try next portable layout */ }
    }
    if (!manifest || typeof manifest.name !== 'string') throw new Error('A supported plugin.json manifest with a name is required')
    const current = await readJson(path.join(target, 'plugin.json'), null)
    if (current && !update) throw new Error('Plugin exists; use plugin update')
    const portable = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json'].includes(manifestFile)
    // Managed plugins are normalized to a root manifest. Preserve the portable
    // default skill locations that would otherwise disappear with that move.
    const safe = { ...manifest, name, enabled: current ? current.enabled !== false : manifest.enabled !== false && manifest.disabled !== true, ...(portable && manifest.skills === undefined && manifest.components?.skills === undefined ? { skills: ['./skills', './'] } : {}) }
    await writeJsonAtomic(path.join(payload, 'plugin.json'), safe)
    const snapshot = await inspectPluginContent(payload)
    const addedCapabilities = snapshot.capabilities.filter(capability => !oldLock?.capabilities?.includes(capability))
    const changedSource = oldLock && (oldLock.source !== source || oldLock.revision !== (revision || null))
    const pendingApproval = Boolean(oldLock?.pendingApproval)
      || Boolean(snapshot.requiresApproval && (!oldLock || snapshot.contentHash !== oldLock.contentHash))
      || Boolean(changedSource) || Boolean(current && (!oldLock || addedCapabilities.length))
    if (pendingApproval) { safe.enabled = false; await writeJsonAtomic(path.join(payload, 'plugin.json'), safe) }
    const record = { ...snapshot, source, revision: revision || null, packageIntegrity, installedAt: Date.now(), enabled: safe.enabled, pendingApproval,
      addedCapabilities: current ? addedCapabilities : snapshot.capabilities,
      approval: !pendingApproval ? { method: 'explicit-install-or-compatible-update', at: Date.now() } : null }
    await publishPluginContent(payload, snapshot)
    // Place the managed marker before publishing the directory. If the separate
    // private lock cannot be committed, the loader refuses this unverified tree.
    await writeJsonAtomic(path.join(payload, 'kkcode-install.json'), { source, revision: revision || null, installedAt: record.installedAt, version: manifest.version || null })
    if (current) { backup = path.join(staging, 'previous'); await rename(target, backup) }
    await rename(payload, target)
    await writePluginLock(name, record)
    return { name, version: manifest.version, installed: true, contentHash: snapshot.contentHash, enabled: safe.enabled, pendingApproval, addedCapabilities: record.addedCapabilities }
  } catch (error) {
    if (backup) { await rm(target, { recursive: true, force: true }); await rename(backup, target); if (oldLock) await writePluginLock(name, oldLock) }
    throw error
  } finally { try { if (staging) await rm(staging, { recursive: true, force: true }) } finally { await lock.release() } }
}
/** @param {string} name @param {string} action @param {{source?: string, revision?: string, confirmHash?: string}} [options] */
export async function managePlugin(name, action, options = {}) {
  if (action === 'update') return managePluginUnlocked(name, action, options)
  const lock = await acquireProcessLock(path.join(userRootDir(), 'plugin-locks', `${pluginName(name)}.install.lock`))
  try { return await managePluginUnlocked(name, action, options) } finally { await lock.release() }
}
async function managePluginUnlocked(name, action, options) {
  const root = path.join(userRootDir(), 'plugins'), target = path.join(root, pluginName(name))
  const info = await lstat(target)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Managed plugin root must be a directory, not a symbolic link')
  const manifest = await readJson(path.join(target, 'plugin.json'), null)
  if (!manifest) throw new Error('Managed plugin not found')
  if (action === 'update') {
    const install = await readPluginLock(name)
    if (!install || install.source === 'legacy-local' && !options.source) throw new Error('旧插件没有可信的更新来源，请用 --source 明确指定固定版本来源。')
    if (!options.source && !install.source.startsWith('npm:') && !/^https:\/\//.test(install.source) && !path.isAbsolute(install.source)) throw new Error('旧插件记录的是相对来源，请用 --source 明确指定绝对本地来源后再更新。')
    return installPlugin({ name, source: options.source || install.source, revision: options.revision || install.revision, update: true })
  }
  if (action === 'remove') {
    const trash = path.join(userRootDir(), 'plugin-trash')
    await mkdir(trash, { recursive: true, mode: 0o700 })
    await rename(target, path.join(trash, `${name}-${Date.now()}`))
    return { name, removed: true, recoverable: true }
  }
  const locked = await readPluginLock(name)
  if (action === 'inspect') return { name, ...await inspectPluginContent(target), lock: locked, status: await verifyManagedPlugin(target) }
  if (action === 'approve') {
    const inspected = await inspectPluginContent(target)
    if (typeof options.confirmHash !== 'string' || options.confirmHash !== inspected.contentHash) throw new Error(`请检查插件源码与新增能力，再使用 --confirm-hash ${inspected.contentHash} 明确批准；可执行插件属于高信任宿主代码。`)
    const record = { ...locked, ...inspected, source: locked?.source || 'legacy-local', revision: locked?.revision || null, installedAt: locked?.installedAt || Date.now(), enabled: true, pendingApproval: false, approval: { method: 'exact-content-hash', at: Date.now() }, addedCapabilities: [] }
    await publishPluginContent(target, inspected)
    await writePluginLock(name, record)
    await writeJsonAtomic(path.join(target, 'kkcode-install.json'), { source: record.source, revision: record.revision, version: record.version, installedAt: record.installedAt })
    manifest.enabled = true; await writeJsonAtomic(path.join(target, 'plugin.json'), manifest)
    return { name, enabled: true, contentHash: inspected.contentHash }
  }
  if (!['enable', 'disable'].includes(action)) throw new Error('Unknown plugin action')
  if (action === 'enable') {
    const integrity = await verifyManagedPlugin(target)
    if (integrity && (!integrity.verified || integrity.pendingApproval)) throw new Error(integrity.reason || '插件内容未获批准，请先检查并确认当前内容哈希。')
  }
  if (locked) await writePluginLock(name, { ...locked, enabled: action === 'enable' })
  manifest.enabled = action === 'enable'; await writeJsonAtomic(path.join(target, 'plugin.json'), manifest)
  return { name, enabled: manifest.enabled }
}
