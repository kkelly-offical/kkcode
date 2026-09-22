import path from 'node:path'
import os from 'node:os'
import { realpath, readdir, lstat, open, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { ProtocolError } from '../protocol/index.mjs'
import { userRootDir } from '../storage/paths.mjs'

const blocked = new Set(['.ssh', '.aws', '.azure', '.gnupg', '.kube', '.kkcode', '.codex', '.claude', '.config', '.npmrc', '.netrc', '.git-credentials', '.env'])
const within = (target, root) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
const identity = info => info.ino > 0n ? `${info.dev}:${info.ino}` : null
function assertPublicComponents(target) {
  if (target.split(path.sep).some(part => blocked.has(part.toLowerCase()) || /^\.env\./i.test(part) || /\.(pem|key|p12|pfx|jks|keystore)$/i.test(part))) throw new ProtocolError('path_denied', '凭据和私密配置受到保护，不能通过远控文件浏览读取。', 403)
}
function requestedPath(input) {
  if (typeof input !== 'string' || !input || input.length > 32768 || input.includes('\0')) throw new ProtocolError('invalid_path', 'Choose a valid device path')
  return path.resolve(input)
}
async function pathPolicy(roots) {
  const configured = roots.map(root => path.resolve(root))
  // A missing/unreachable configured root degrades to "nothing under it
  // resolves" instead of breaking every other root.
  const allowed = (await Promise.all(configured.map(root => realpath(root).catch(() => null)))).filter(Boolean)
  // All-folder consent covers ordinary files, not process environments,
  // device nodes, runtime sockets or OS credential stores.
  const systemPrivate = process.platform === 'win32' ? [] : ['/proc', '/sys', '/dev', '/run', '/var/run', '/etc/ssh', '/etc/ssl/private', '/etc/shadow', '/etc/gshadow', '/etc/master.passwd', '/etc/krb5.keytab']
  const privateRoots = [userRootDir(), process.env.KKCODE_ANDROID_SIGNING_DIR || path.join(os.homedir(), '.local/share/kkcode-signing'), process.env.KKCODE_LAB_STATE || path.join(os.homedir(), '.local/share/kkcode-enterprise-lab'), ...systemPrivate].map(folder => path.resolve(folder))
  const protectedPaths = await Promise.all(privateRoots.map(folder => realpath(folder).catch(() => folder)))
  const privateIdentities = new Set((await Promise.all(protectedPaths.map(async folder => {
    try { return identity(await stat(folder, { bigint: true })) } catch { return null }
  }))).filter(Boolean))
  const rootIdentities = new Map(await Promise.all([...new Set([...configured, ...allowed])].map(async folder => [folder, await stat(folder, { bigint: true }).then(identity, () => null)])))
  return { configured, allowed, privateRoots, protectedPaths, privateIdentities, rootIdentities }
}
async function scopeRoot(target, roots, rootIdentities) {
  const exact = roots.find(root => within(target, root))
  if (exact) return exact
  // Case aliases (NTFS, default APFS, etc.) are admitted only after the root
  // itself is proven identical. Case-sensitive siblings stay out of scope.
  const targetParts = target.split(path.sep).filter(Boolean)
  for (const root of roots) {
    const rootParts = root.split(path.sep).filter(Boolean)
    if (targetParts.length < rootParts.length || rootParts.some((part, index) => part.toLowerCase() !== targetParts[index].toLowerCase())) continue
    let alias = target
    for (let index = rootParts.length; index < targetParts.length; index++) alias = path.dirname(alias)
    try { if (rootIdentities.get(root) && identity(await stat(alias, { bigint: true })) === rootIdentities.get(root)) return alias } catch { /* Missing or inaccessible aliases are outside scope. */ }
  }
}
async function resolveWithPolicy(requested, policy, { directory = false } = {}) {
  const { configured, allowed, privateRoots, protectedPaths, privateIdentities, rootIdentities } = policy
  // Check lexical scope before resolving an attacker-chosen path. In particular,
  // an unapproved Windows UNC path must not initiate an SMB/credential lookup.
  if (!await scopeRoot(requested, [...configured, ...allowed], rootIdentities)) throw new ProtocolError('path_denied', '此目录尚未获得远程访问授权。请在被控电脑终端重新启动 kkcode remote，确认允许所有普通目录，或使用 --root 明确授权。', 403)
  assertPublicComponents(requested)
  const denyPrivate = () => { throw new ProtocolError('path_denied', 'KK Code 私密状态、登录凭据和签名文件受到保护。', 403) }
  if ([...privateRoots, ...protectedPaths].some(folder => within(requested, folder))) denyPrivate()
  let target
  try { target = await realpath(requested) }
  catch (error) {
    if (error.code === 'ENOENT') throw new ProtocolError('path_missing', '此路径在被控设备上不存在，请选择该设备实际存在的目录。', 404)
    if (['EACCES', 'EPERM'].includes(error.code)) throw new ProtocolError('folder_unreadable', '被控设备当前系统用户没有权限访问此目录；远控授权不会提升系统权限。', 403)
    throw error
  }
  const root = await scopeRoot(target, allowed, rootIdentities)
  if (!root) throw new ProtocolError('path_denied', '此目录或其链接目标尚未获得远程访问授权，请在被控电脑终端调整访问范围。', 403)
  if (protectedPaths.some(folder => within(target, folder))) denyPrivate()
  assertPublicComponents(target)
  // Case-insensitive filesystems and short-name aliases can spell the same
  // private directory differently. Compare ancestor identities, not case folds.
  for (let ancestor = target; within(ancestor, root); ancestor = path.dirname(ancestor)) {
    if (privateIdentities.has(identity(await stat(ancestor, { bigint: true })))) denyPrivate()
    if (ancestor === root || ancestor === path.dirname(ancestor)) break
  }
  if (directory && !(await stat(target)).isDirectory()) throw new ProtocolError('not_directory', '请选择文件夹，而不是文件。')
  return target
}
export async function resolveDevicePath(input, roots, options = {}) {
  const requested = requestedPath(input)
  return resolveWithPolicy(requested, await pathPolicy(roots), options)
}
/** Validate a not-yet-existing direct child without resolving an untrusted UNC
 * target or creating directories before consent/private-path checks succeed. */
export async function resolveNewDevicePath(input, roots) {
  const requested = requestedPath(input), policy = await pathPolicy(roots)
  assertPublicComponents(requested)
  if ([...policy.privateRoots, ...policy.protectedPaths].some(folder => within(requested, folder))) throw new ProtocolError('path_denied', 'Private state cannot be used as a worktree location', 403)
  const parent = await resolveWithPolicy(path.dirname(requested), policy, { directory: true })
  const target = path.join(parent, path.basename(requested))
  assertPublicComponents(target)
  if ([...policy.privateRoots, ...policy.protectedPaths].some(folder => within(target, folder))) throw new ProtocolError('path_denied', 'Private state cannot be used as a worktree location', 403)
  if (await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null })) throw new ProtocolError('path_exists', 'Choose a new folder; existing files and directories are never replaced', 409)
  return target
}
export async function listDeviceFolder(input, roots) {
  const policy = await pathPolicy(roots)
  // No path: open the first reachable root (default: the OS user's home).
  let start = input
  if (!start) for (const root of roots) { start = await realpath(root).catch(() => null); if (start) break }
  const folder = await resolveWithPolicy(requestedPath(start || roots[0]), policy, { directory: true })
  let dirents
  try { dirents = await readdir(folder, { withFileTypes: true }) }
  catch (error) { throw new ProtocolError(error.code === 'ENOENT' ? 'path_missing' : 'folder_unreadable', error.code === 'ENOENT' ? '此目录已不存在，请刷新列表。' : '当前系统用户无法列出此目录，请选择有权限的目录。', error.code === 'ENOENT' ? 404 : 403) }
  const entries = []
  for (const item of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entries.length >= 1000) break
    try {
      const resolved = await resolveWithPolicy(path.join(folder, item.name), policy)
      entries.push({ name: item.name, path: resolved, directory: (await stat(resolved)).isDirectory() })
    } catch { /* inaccessible/protected paths are not enumerated */ }
  }
  // Clients navigate up until parent is null instead of string-guessing into
  // a path_denied error at the root boundary.
  const parentDir = path.dirname(folder)
  const parent = parentDir !== folder && await scopeRoot(parentDir, policy.allowed, policy.rootIdentities) ? parentDir : null
  return { path: folder, parent, roots, entries }
}
export async function readDeviceFile(input, roots) {
  const requested = requestedPath(input), policy = await pathPolicy(roots)
  const file = await resolveWithPolicy(requested, policy)
  const before = await lstat(file, { bigint: true }), limit = 2 * 1024 * 1024
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(limit)) throw new ProtocolError('file_limit', 'Preview supports regular text files up to 2 MiB')
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const pinned = await handle.stat({ bigint: true }), verified = await resolveWithPolicy(file, policy), current = await lstat(verified, { bigint: true })
    if (verified !== file || !pinned.isFile() || pinned.ino !== before.ino || pinned.dev !== before.dev || pinned.ino !== current.ino || pinned.dev !== current.dev || current.isSymbolicLink()) throw new ProtocolError('file_changed', 'The file changed while it was being opened; retry the preview', 409)
    const chunks = []; let total = 0
    while (true) {
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - total))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total)
      if (!bytesRead) break
      total += bytesRead
      if (total > limit) throw new ProtocolError('file_limit', 'Preview supports text files up to 2 MiB')
      chunks.push(chunk.subarray(0, bytesRead))
    }
    const content = Buffer.concat(chunks).toString('utf8')
    if (content.includes('\0')) throw new ProtocolError('binary_file', 'Binary file preview is unavailable')
    return { path: file, content }
  } finally { await handle.close() }
}
