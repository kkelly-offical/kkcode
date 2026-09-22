import path from 'node:path'
import { persistTrust } from '../kernel/index.mjs'
import { resolveDevicePath } from '../device/files.mjs'

/** Explicit local operator opt-in. Folder browsing alone never grants code or
 * credential-source trust. Validate every root before persisting any grant. */
export async function grantRemoteWorkspaceTrust(roots, {
  enabled = false,
  grant = persistTrust,
  resolve = resolveDevicePath
} = {}) {
  if (enabled !== true) return []
  const resolved = [...new Set(await Promise.all(roots.map(root => resolve(root, roots, { directory: true }))))]
  const within = (target, root) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
  const minimal = resolved.filter(root => !resolved.some(other => other !== root && within(root, other)))
  for (const root of minimal) await grant(root, { recursive: true })
  return minimal
}
