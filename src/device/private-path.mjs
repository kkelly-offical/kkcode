import { ProtocolError } from '../protocol/index.mjs'

const blocked = new Set(['.ssh', '.aws', '.azure', '.gnupg', '.kube', '.kkcode', '.codex', '.claude', '.config', '.npmrc', '.netrc', '.git-credentials', '.env'])

/** Pure spelling guard, also exercised for Windows on POSIX test hosts. The
 * device service always uses the actual platform; clients cannot select it. */
export function assertPublicDeviceComponents(target, { platform = process.platform } = {}) {
  const windows = platform === 'win32'
  const parts = target.split(windows ? /[\\/]/ : '/')
  for (const [index, raw] of parts.entries()) {
    if (windows && index === 0 && /^[A-Za-z]:$/.test(raw)) continue
    // NTFS streams are not ordinary files. A suffix such as :secret or ::$DATA
    // must not turn .env/private.key into an apparently harmless component.
    // Win32 also ignores trailing dots/spaces and has reserved device names.
    const part = windows ? raw.replace(/[. ]+$/g, '') : raw
    if (windows && (raw.includes(':') || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) ||
        blocked.has(part.toLowerCase()) || /^\.env\./i.test(part) || /\.(pem|key|p12|pfx|jks|keystore)$/i.test(part)) {
      throw new ProtocolError('path_denied', '凭据、私密配置和特殊设备路径受到保护，不能通过远控文件浏览读取。', 403)
    }
  }
}
