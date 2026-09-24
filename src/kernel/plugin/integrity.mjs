import path from 'node:path'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir, lstat, realpath, mkdir, cp, rename, rm, mkdtemp } from 'node:fs/promises'
import { userRootDir } from '../../storage/paths.mjs'
import { writePrivateFile } from '../../storage/private-file.mjs'
import { normalizePluginCapabilities } from './capabilities.mjs'

const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const invalid = message => { throw Object.assign(new Error(message), { code: 'plugin_integrity_error' }) }
const lockPath = name => path.join(userRootDir(), 'plugin-locks', `${name}.json`)
const nameOk = name => { if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(name)) invalid('插件名称无效。'); return name }
const json = text => { try { return JSON.parse(text) } catch { invalid('插件JSON记录无法解析，未输出原始内容。') } }

export async function readPluginLock(name) {
  let handle
  try {
    handle = await open(lockPath(nameOk(name)), constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024 || process.platform !== 'win32' && (stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid())) invalid('插件锁必须为本账号私有的普通文件。')
    const value = json(await handle.readFile('utf8'))
    if (value.schema !== 'kk.plugin-lock.v1' || value.name !== name || !/^[a-f0-9]{64}$/.test(value.contentHash) || !Array.isArray(value.capabilities) || typeof value.enabled !== 'boolean') invalid('插件锁记录损坏；未自动信任当前内容。')
    return value
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  finally { await handle?.close() }
}
export async function writePluginLock(name, value) { await writePrivateFile(lockPath(nameOk(name)), JSON.stringify({ ...value, schema: 'kk.plugin-lock.v1', name })) }

/** Content inventory only, never imports modules or executes package scripts. */
export async function inspectPluginContent(rootDir) {
  if ((await lstat(rootDir)).isSymbolicLink()) invalid('托管插件根目录不能是符号链接。')
  const root = await realpath(rootDir), files = []
  let total = 0, totalBytes = 0, executable = false
  async function walk(dir, prefix = '', depth = 0) {
    if (depth > 64) invalid('插件目录层级超过安全上限。')
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (entry.name.toLowerCase() === '.git') invalid('托管插件不能包含未锁定的Git管理目录。')
      if (!prefix && entry.name === 'kkcode-install.json') continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name, target = path.join(dir, entry.name), stat = await lstat(target)
      if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) invalid('插件包包含符号链接、硬链接或特殊文件，不能作为锁定内容加载。')
      if (stat.isDirectory()) { await walk(target, relative, depth + 1); continue }
      if (++total > 10000) invalid('插件文件数量超过安全上限。')
      if (stat.size > 16 * 1024 * 1024) invalid('插件单文件超过16 MiB安全上限。')
      let handle
      try {
        handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
        const opened = await handle.stat()
        if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1) invalid('插件在读取时被替换。')
        let bytes = await handle.readFile()
        if (bytes.length !== stat.size || (await handle.stat()).mtimeMs !== stat.mtimeMs) invalid('插件在校验时发生变化。')
        if (relative === 'plugin.json') {
          const manifest = json(bytes.toString('utf8')); delete manifest.enabled
          bytes = Buffer.from(JSON.stringify(canonical(manifest)))
        }
        files.push({ path: relative, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), executable: Boolean(stat.mode & 0o111) })
        if (/\.(?:mjs|cjs|js|ts|py|sh|ps1|cmd|bat|exe|dll|so|dylib|wasm)$/i.test(relative) || Boolean(stat.mode & 0o111)) executable = true
        totalBytes += stat.size
        if (totalBytes > 128 * 1024 * 1024) invalid('插件总内容超过128 MiB安全上限。')
      } finally { await handle?.close() }
    }
  }
  await walk(root)
  const handle = await open(path.join(root, 'plugin.json'), constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  let manifest
  try { manifest = json(await handle.readFile('utf8')) } finally { await handle.close() }
  const components = manifest.components || {}, capabilities = []
  for (const key of ['skills', 'agents', 'hooks', 'mcp', 'mcpServers', 'mcp_servers', 'tools', 'commands', 'lsp', 'capabilities', 'permissions', 'allowedAgentPermissions', 'allowed_agent_permissions']) {
    const value = manifest[key] ?? components[key]
    if (value !== undefined) capabilities.push(`${key}:${digest(canonical(value))}`)
  }
  if (executable) capabilities.push('host-executable-code')
  const activeIntegration = ['hooks', 'mcp', 'mcpServers', 'mcp_servers', 'tools', 'commands', 'lsp'].some(key => {
    const value = manifest[key] ?? components[key]
    return value && (typeof value === 'string' || Array.isArray(value) && value.length > 0 || typeof value === 'object' && Object.keys(value).length > 0)
  })
  const elevatedAgents = normalizePluginCapabilities(manifest).allowedAgentPermissions.some(value => value !== 'default')
  return { contentHash: digest(files), files: files.length, totalBytes, executable, requiresApproval: Boolean(executable || activeIntegration || elevatedAgents), capabilities: capabilities.sort(), version: manifest.version || null }
}

/** Immutable, content-addressed import location. Updating the active install
 * never swaps code under an already verified import path or its relative imports. */
export async function publishPluginContent(payload, snapshot) {
  if (!/^[a-f0-9]{64}$/.test(snapshot.contentHash)) invalid('插件内容哈希无效。')
  const root = path.join(userRootDir(), 'plugin-content'), target = path.join(root, snapshot.contentHash)
  await mkdir(root, { recursive: true, mode: 0o700 })
  try {
    if ((await inspectPluginContent(target)).contentHash !== snapshot.contentHash) invalid('不可变插件缓存已经损坏，未覆盖原证据。')
    return target
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = await mkdtemp(path.join(root, '.publish-'))
  try {
    await cp(payload, temporary, { recursive: true, filter: source => path.basename(source) !== 'kkcode-install.json' })
    if ((await inspectPluginContent(temporary)).contentHash !== snapshot.contentHash) invalid('插件在发布内容副本时变化，未启用。')
    try { await rename(temporary, target) } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || (await inspectPluginContent(target)).contentHash !== snapshot.contentHash) throw error
    }
    return target
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

/** Only managed packages have locks; manually authored trusted compatibility
 * directories keep their existing separate workspace-trust semantics. */
export async function verifyManagedPlugin(rootDir) {
  const name = path.basename(rootDir), managedRoot = path.resolve(userRootDir(), 'plugins')
  if (path.dirname(path.resolve(rootDir)) !== managedRoot || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(name)) return null
  const lock = await readPluginLock(name)
  let marker = false
  try { marker = (await lstat(path.join(rootDir, 'kkcode-install.json'))).isFile() } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!lock && !marker) return null
  if (!lock) return { verified: false, enabled: false, reason: '旧的托管插件没有内容锁，需要先检查并明确批准。' }
  let handle
  try {
    handle = await open(path.join(rootDir, 'kkcode-install.json'), constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024) invalid('插件安装记录不可用。')
    const metadata = json(await handle.readFile('utf8'))
    if (Object.keys(metadata).some(key => !['source', 'revision', 'version', 'installedAt'].includes(key)) || metadata.source !== lock.source || metadata.revision !== lock.revision || metadata.version !== lock.version || metadata.installedAt !== lock.installedAt) invalid('插件安装来源与私密锁不一致，不能加载或改用新来源。')
  } finally { await handle?.close() }
  const snapshot = await inspectPluginContent(rootDir)
  if (snapshot.contentHash !== lock.contentHash) return { verified: false, enabled: false, reason: '插件内容与安装锁不一致，已拒绝加载；请检查变更，不要自动重新授权。' }
  const loadRoot = path.join(userRootDir(), 'plugin-content', lock.contentHash)
  if ((await inspectPluginContent(loadRoot)).contentHash !== lock.contentHash) invalid('不可变插件内容已损坏，拒绝执行。')
  return { verified: true, enabled: lock.enabled && !lock.pendingApproval, pendingApproval: lock.pendingApproval === true, contentHash: lock.contentHash,
    loadRoot,
    reason: lock.pendingApproval ? '插件新增能力或可执行内容发生变化，需要按当前内容哈希重新批准。' : null }
}

/** Resolve every loose path consumer too, not only plugin.json discovery.
 * Direct cache/trash paths are not an alternate way to activate disabled code.
 * Manifest component paths have already been verified and carry a trusted
 * consumer-only flag; this option is never read from project configuration. */
export async function resolveManagedPluginPath(input, { verifiedManifestRoot = null } = {}) {
  const absolute = path.resolve(input)
  let actual
  try { actual = await realpath(absolute) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  const inside = (root, value) => value === root || value.startsWith(root + path.sep)
  const state = path.resolve(userRootDir()), managed = path.join(state, 'plugins')
  for (const name of ['plugin-content', 'plugin-trash']) {
    const logical = path.join(state, name), canonicalRoot = await realpath(logical).catch(() => logical)
    if (inside(logical, absolute) || inside(canonicalRoot, actual)) {
      if (name !== 'plugin-content' || typeof verifiedManifestRoot !== 'string' || !/^[a-f0-9]{64}$/.test(path.basename(verifiedManifestRoot))) return null
      const approved = await realpath(verifiedManifestRoot).catch(() => null)
      return approved && path.dirname(approved) === canonicalRoot && inside(approved, actual) ? absolute : null
    }
  }
  const canonicalManaged = await realpath(managed).catch(() => managed)
  // Prefer the actual managed ancestor: an unmanaged wrapper inside plugins/
  // may itself contain a directory alias into a pending managed package.
  const relative = inside(canonicalManaged, actual) ? path.relative(canonicalManaged, actual)
    : inside(managed, absolute) ? path.relative(managed, absolute) : null
  if (relative === null) return absolute // Author-maintained compatibility directory.
  const [name, ...remaining] = relative.split(path.sep)
  if (!name || name.startsWith('.')) return null
  const installed = path.join(managed, name)
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(name)) {
    // The manager has never accepted this name, but older author-maintained
    // compatibility directories can use Unicode/capitalized/scoped names.
    try { await lstat(path.join(installed, 'kkcode-install.json')); return null }
    catch (error) { return error.code === 'ENOENT' ? absolute : null }
  }
  let status
  try { status = await verifyManagedPlugin(installed) } catch { return null }
  if (!status) return absolute // Never-managed local package keeps workspace trust semantics.
  if (!status.verified || !status.enabled) return null
  const mapped = path.join(status.loadRoot, ...remaining)
  try { if (!inside(await realpath(status.loadRoot), await realpath(mapped))) return null } catch { return null }
  return mapped
}
