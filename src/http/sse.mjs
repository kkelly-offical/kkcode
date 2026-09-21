import { SSE_KEEPALIVE_MS, SSE_MAX_BUFFERED_BYTES, SSE_RETRY_MS, SESSION_IDLE_TYPES, SESSION_RUNNING_TYPES } from '../protocol/index.mjs'

/**
 * Shared server-sent events (SSE) IO for the device server and the relay
 * gateway. The wire contract lives in docs/remote-sse-contract.md.
 *
 * A writer owns one hijacked HTTP response. `send` returns false once the
 * client falls SSE_MAX_BUFFERED_BYTES behind; the caller then closes the
 * stream — clients reconnect with Last-Event-ID and replay from the journal.
 */
export class SseWriter {
  constructor(reply, { retry = SSE_RETRY_MS, keepaliveMs = SSE_KEEPALIVE_MS, maxBuffered = SSE_MAX_BUFFERED_BYTES } = {}) {
    reply.hijack()
    this.res = reply.raw
    this.maxBuffered = maxBuffered
    this.closed = false
    this.res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // Reverse proxies (and the HA stack) must not buffer a live stream.
      'x-accel-buffering': 'no'
    })
    this.res.write(`retry: ${retry}\n\n`)
    this.keepalive = setInterval(() => this.comment('keepalive'), keepaliveMs)
    this.keepalive.unref?.()
    this.res.on('close', () => { this.closed = true; clearInterval(this.keepalive) })
  }
  write(frame) {
    if (this.closed || this.res.writableEnded) return false
    try { this.res.write(frame) } catch { return false }
    return this.res.writableLength <= this.maxBuffered
  }
  comment(text) { this.write(`: ${String(text).replace(/[\r\n]/g, ' ')}\n\n`) }
  /** One SSE frame. `id`/`event` are single-line scalars; `data` is JSON. */
  send({ id, event, data }) {
    let frame = ''
    if (id != null) frame += `id: ${String(id).replace(/[\r\n]/g, '')}\n`
    if (event != null) frame += `event: ${String(event).replace(/[\r\n]/g, '')}\n`
    frame += `data: ${typeof data === 'string' ? data.replace(/[\r\n]+/g, ' ') : JSON.stringify(data)}\n\n`
    return this.write(frame)
  }
  close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.keepalive)
    try { this.res.end() } catch { /* already gone */ }
  }
}

/** Derive a device-stream session.status transition from a journal row. */
export function sessionStatusFromRow(row) {
  if (!row || typeof row.sessionId !== 'string') return null
  if (SESSION_RUNNING_TYPES.includes(row.type)) return { sessionId: row.sessionId, running: true }
  if (SESSION_IDLE_TYPES.includes(row.type)) return { sessionId: row.sessionId, running: false }
  return null
}

/** Relay uplink rows cross a trust boundary: bound their shape before fanout. */
export function isJournalRow(row) {
  return row && typeof row === 'object'
    && typeof row.sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(row.sessionId)
    && Number.isSafeInteger(row.seq) && row.seq > 0
    && Number.isFinite(row.timestamp)
    && typeof row.type === 'string' && /^[\w.:-]{1,128}$/.test(row.type)
    && (row.payload == null || typeof row.payload === 'object')
}

/** Device-scope (session-less) live events: settings/model catalog changes. */
export function isDeviceEvent(event) {
  return event && typeof event === 'object'
    && typeof event.type === 'string' && /^[\w.:-]{1,128}$/.test(event.type)
    && Number.isFinite(event.timestamp)
    && (event.payload == null || typeof event.payload === 'object')
}

/** Parse the reconnect cursor: `?after=` wins over the Last-Event-ID header. */
export function streamCursor(query, headers) {
  const candidate = query ?? headers?.['last-event-id']
  if (candidate == null || candidate === '') return 0
  const value = Number(candidate)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}
