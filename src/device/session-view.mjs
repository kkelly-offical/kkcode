import { ProtocolError } from '../protocol/index.mjs'
export const SESSION_VIEW_BYTES = 4 * 1024 * 1024
const displayNotice = '[Display truncated; full content remains on the computer]'
const bytes = value => Buffer.byteLength(JSON.stringify(value))
const metadataFields = { id: 128, title: 512, cwd: 4096, mode: 32, modeId: 32, approval: 32, model: 200, providerType: 128, status: 32, createdAt: 0, updatedAt: 0, parentSessionId: 128, forkFrom: 128 }
function clip(value, max) {
  const data = Buffer.from(value)
  if (data.length <= max) return value
  let end = Math.max(0, max)
  while (end > 0 && (data[end] & 0xc0) === 0x80) end--
  return data.subarray(0, end).toString('utf8')
}
/** Transport projection only: canonical history retains actual image content. */
function project(value, budget, depth = 0, seen = new Set()) {
  if (budget.left < 64 || depth > 16) return displayNotice
  if (typeof value === 'string') {
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) return '[Image attachment]'
    const max = Math.min(524288, budget.left - 64), clipped = clip(value, max)
    budget.left -= Buffer.byteLength(clipped)
    return clipped === value ? value : `${clipped}\n${displayNotice}`
  }
  if (!value || typeof value !== 'object') { budget.left -= 16; return value }
  if (['image', 'image_url', 'input_image'].includes(value.type)) {
    const label = clip(String(value.mediaType || value.source?.media_type || 'image'), 80)
    budget.left -= 128
    return { type: 'text', text: `[Image attachment: ${label}]` }
  }
  if (seen.has(value)) return displayNotice
  seen.add(value)
  const result = Array.isArray(value) ? [] : {}
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value)
  let count = 0
  for (const [key, item] of entries) {
    if (count++ >= 2000 || budget.left < 64) { if (Array.isArray(result)) result.push(displayNotice); else result.displayTruncated = true; break }
    budget.left -= String(key).length + 4
    if (Array.isArray(result)) result.push(project(item, budget, depth + 1, seen))
    else if (!['__proto__', 'constructor', 'prototype'].includes(key)) result[key] = project(item, budget, depth + 1, seen)
  }
  seen.delete(value)
  return result
}
function metadata(source, cap) {
  const result = {}
  for (const [key, max] of Object.entries(metadataFields)) {
    if (!Object.hasOwn(source || {}, key)) continue
    const value = source[key]
    if (max && typeof value === 'string') result[key] = clip(value, max)
    else if (!max && Number.isFinite(value)) result[key] = value
    else if (value === null) result[key] = null
  }
  // Tiny custom pages may omit optional display metadata, never user history.
  for (const key of Object.keys(result).filter(key => key !== 'id').sort((a, b) => bytes(result[b]) - bytes(result[a]))) {
    if (bytes(result) <= Math.min(16384, cap / 3)) break
    delete result[key]
  }
  return result
}
function messageIdentity(message) {
  const identity = {}
  for (const key of ['id', 'role', 'turnId']) if (typeof message[key] === 'string') identity[key] = clip(message[key], key === 'role' ? 32 : 128)
  for (const key of ['createdAt', 'step']) if (Number.isFinite(message[key])) identity[key] = message[key]
  for (const key of ['truncated', 'continuation']) if (typeof message[key] === 'boolean') identity[key] = message[key]
  return identity
}
const truncatedMessage = message => ({ ...messageIdentity(message), displayTruncated: true, content: displayNotice })

export function sessionView(data, { before, limit = 100, maxBytes = SESSION_VIEW_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 512) throw new ProtocolError('invalid_limit', 'A history display page requires at least 512 bytes')
  maxBytes = Math.min(maxBytes, SESSION_VIEW_BYTES)
  const source = data.messages || []
  const beforeIndex = before ? source.findIndex(message => message.id === before) : source.length
  if (before && beforeIndex < 0) throw new ProtocolError('invalid_cursor', 'History cursor no longer exists; reload the conversation', 409)
  const end = beforeIndex < 0 ? source.length : beforeIndex, count = Math.max(1, Math.min(200, Number(limit) || 100))
  let start = end, messages = [], parts = [], partsTruncated = false
  const meta = metadata(data.session, maxBytes)
  const view = () => ({ ...meta, messages, parts, partsTruncated, historyHasMore: start > 0, nextBefore: start > 0 ? source[start]?.id : null })
  for (let index = end - 1; index >= Math.max(0, end - count); index--) {
    let item = { ...project(source[index], { left: Math.floor(maxBytes / 2) }), ...messageIdentity(source[index]) }
    if (bytes(item) > maxBytes / 2) item = truncatedMessage(source[index])
    const candidate = [item, ...messages]
    if (messages.length && bytes(candidate) > maxBytes / 2) break
    messages = candidate; start = index
  }
  const since = Number.isFinite(source[start]?.createdAt) ? source[start].createdAt : -Infinity
  // A page ending before message@30 still owns tools@20 after message@10.
  // The next message is the exclusive upper bound, not the last selected one.
  const until = end < source.length && Number.isFinite(source[end]?.createdAt) ? source[end].createdAt : Infinity
  const selected = new Set(messages.map(message => message.id)), known = new Set(source.map(message => message.id))
  const candidates = (data.parts || []).filter(part => part.messageId && known.has(part.messageId)
    ? selected.has(part.messageId)
    : !Number.isFinite(part.createdAt) || part.createdAt >= since && part.createdAt < until)
  for (let index = candidates.length - 1; index >= 0; index--) {
    const item = project(candidates[index], { left: Math.floor(maxBytes / 2) })
    parts.unshift(item)
    if (bytes(view()) > maxBytes) { parts.shift(); partsTruncated = true; break }
  }
  if (bytes(view()) > maxBytes && messages.length) { messages = [truncatedMessage(messages.at(-1))]; start = end - 1 }
  if (bytes(view()) > maxBytes) throw new ProtocolError('history_page_limit', 'This display page budget is too small; request a larger page', 413)
  return view()
}
