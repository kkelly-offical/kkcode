/** Browser-safe, explicitly requested download. Never executes or renders artifact content. */
const MAX_BYTES = 128 * 1024 * 1024
const fail = message => { throw Object.assign(new Error(message), { code: 'artifact_download_invalid' }) }
export async function downloadArtifact(client, { sessionId, id, maxBytes = MAX_BYTES, signal, onProgress } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_BYTES) fail('下载大小限制无效，最大支持128 MiB。')
  if (!globalThis.crypto?.subtle) fail('当前浏览器环境无法校验文件完整性，请使用HTTPS或本机安全连接后重试。')
  let cursor, received = 0, first
  const parts = [], cursors = new Set()
  do {
    signal?.throwIfAborted()
    const page = await client.request('artifacts.download', { sessionId, id, ...(cursor ? { cursor } : {}), limit: 256 * 1024 }, { signal })
    if (!page || page.id !== id || !/^[a-f0-9]{64}$/.test(page.sha256) || !Number.isSafeInteger(page.size) || page.size < 0 || page.size > maxBytes ||
        page.offset !== received || page.encoding !== 'base64' || typeof page.data !== 'string' || page.data.length > 349528 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(page.data)) fail('设备返回了无效的文件分块；未保存不完整文件。')
    first ||= page
    if (first.sha256 !== page.sha256 || first.size !== page.size) fail('下载过程中产物版本发生变化，请重新获取文件。')
    const bytes = Uint8Array.from(atob(page.data), character => character.charCodeAt(0))
    received += bytes.byteLength
    if (received > first.size || received > maxBytes) fail('文件分块超过声明的大小，下载已停止。')
    cursor = page.nextCursor
    if (cursor !== null && (typeof cursor !== 'string' || !cursor || cursor.length > 2048 || cursors.has(cursor) || !bytes.length)) fail('文件分页未向前推进，下载已停止；请检查被控设备版本。')
    if (cursor) cursors.add(cursor)
    parts.push(bytes)
    onProgress?.(received, first.size)
  } while (cursor !== null)
  if (received !== first.size) fail('文件尚未完整传输，请重新下载；已有分块未作为完整文件保存。')
  signal?.throwIfAborted()
  // Always download as octet-stream: untrusted HTML/SVG must not gain the UI's origin.
  const blob = new Blob(parts, { type: 'application/octet-stream' })
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('')
  signal?.throwIfAborted()
  if (hash !== first.sha256) fail('文件SHA-256校验失败，未提供下载；请检查被控设备的存储。')
  return { id, sha256: hash, size: received, mime: typeof first.mime === 'string' ? first.mime : 'application/octet-stream', blob }
}
