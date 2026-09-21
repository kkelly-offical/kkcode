import path from 'node:path'
import os from 'node:os'
import { realpath, readdir, lstat, open, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { ProtocolError } from '../protocol/index.mjs'
import { userRootDir } from '../storage/paths.mjs'

const blocked = new Set(['.ssh', '.aws', '.azure', '.gnupg', '.kube', '.kkcode', '.codex', '.claude', '.config', '.npmrc', '.netrc', '.git-credentials', '.env'])
export async function resolveDevicePath(input, roots, { directory = false } = {}) {
  const target = await realpath(path.resolve(input))
  const allowed = await Promise.all(roots.map(root => realpath(root)))
  const root = allowed.find(root => target === root || target.startsWith(root + path.sep))
  if (!root) throw new ProtocolError('path_denied', 'Path is outside the allowed device folders', 403)
  const privateRoots = [userRootDir(), process.env.KKCODE_ANDROID_SIGNING_DIR || path.join(os.homedir(), '.local/share/kkcode-signing'), process.env.KKCODE_LAB_STATE || path.join(os.homedir(), '.local/share/kkcode-enterprise-lab')]
  const protectedPaths = await Promise.all(privateRoots.map(folder => realpath(folder).catch(() => path.resolve(folder))))
  if (protectedPaths.some(folder => target === folder || target.startsWith(folder + path.sep))) throw new ProtocolError('path_denied', 'KK Code private state and credentials are protected', 403)
  const parts = target.split(path.sep)
  if (parts.some(part => blocked.has(part.toLowerCase()) || /^\.env\./i.test(part) || /\.(pem|key|p12|pfx|jks|keystore)$/i.test(part))) throw new ProtocolError('path_denied', 'Credential paths are protected', 403)
  if (directory && !(await stat(target)).isDirectory()) throw new ProtocolError('not_directory', 'Choose a folder')
  return target
}
export async function listDeviceFolder(input, roots) {
  const folder = await resolveDevicePath(input || roots[0], roots, { directory: true })
  const entries = []
  for (const item of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entries.length >= 1000) break
    try {
      const resolved = await resolveDevicePath(path.join(folder, item.name), roots)
      entries.push({ name: item.name, path: resolved, directory: (await stat(resolved)).isDirectory() })
    } catch { /* inaccessible/protected paths are not enumerated */ }
  }
  return { path: folder, roots, entries }
}
export async function readDeviceFile(input, roots) {
  const file = await resolveDevicePath(input, roots)
  const before = await lstat(file), limit = 2 * 1024 * 1024
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw new ProtocolError('file_limit', 'Preview supports regular text files up to 2 MiB')
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const pinned = await handle.stat(), verified = await resolveDevicePath(file, roots), current = await lstat(verified)
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
