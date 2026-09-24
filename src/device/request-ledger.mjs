import { readFile } from 'node:fs/promises'
import { writePrivateFile } from '../storage/private-file.mjs'
import { ProtocolError } from '../protocol/index.mjs'

export const REQUEST_WINDOW_MS = 15 * 60000
export const REQUEST_DEFAULTS = Object.freeze({ maxEntries: 10000, maxBytes: 8 * 1024 * 1024, maxAgeMs: 7 * 86400000, maxResultBytes: 64 * 1024 })
const FAILURE_RESERVE_BYTES = 512
const states = new Set(['running', 'unknown', 'done', 'failed'])
const size = value => Buffer.byteLength(JSON.stringify(value))
const capacityError = () => new ProtocolError('idempotency_capacity', 'Request journal is full; wait for the retry window to expire or inspect uncertain operations locally', 503)

/** Bounded idempotency journal. Uncertain crash outcomes are never evicted. */
export class RequestLedger {
  constructor(file, { now = Date.now, ...limits } = {}) {
    this.file = file; this.now = now; this.limits = { ...REQUEST_DEFAULTS, ...limits }
    this.limits.maxAgeMs = Math.max(REQUEST_WINDOW_MS, this.limits.maxAgeMs)
    for (const name of Object.keys(REQUEST_DEFAULTS)) if (!Number.isSafeInteger(this.limits[name]) || this.limits[name] < (name === 'maxResultBytes' ? 0 : 1)) throw new TypeError(`Invalid request journal limit: ${name}`)
    this.entries = Object.create(null); this.chain = Promise.resolve()
  }
  async initialize() {
    let saved = {}
    try { saved = JSON.parse(await readFile(this.file, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid device request journal')
    for (const [key, entry] of Object.entries(saved)) {
      if (!entry || typeof entry !== 'object' || !states.has(entry.state) || typeof entry.hash !== 'string') throw new Error('Invalid device request journal entry')
      this.entries[key] = { ...entry, state: entry.state === 'running' ? 'unknown' : entry.state, at: Number.isFinite(entry.at) ? entry.at : this.now() }
    }
    this.compact(); await this.persist(); return this
  }
  get(key) { return Object.hasOwn(this.entries, key) ? this.entries[key] : undefined }
  reservedBytes(entries = this.entries) { return size(entries) + Object.values(entries).filter(entry => entry.state === 'running').length * FAILURE_RESERVE_BYTES }
  compact(reserveBytes = 0, reserveCount = 0) {
    const now = this.now()
    let count = Object.keys(this.entries).length, bytes = this.reservedBytes()
    const candidates = Object.entries(this.entries).filter(([, entry]) => ['done', 'failed'].includes(entry.state)).sort((a, b) => a[1].at - b[1].at)
    for (const [key, entry] of candidates) {
      const outsideWindow = now - entry.at > REQUEST_WINDOW_MS
      const expired = now - entry.at > this.limits.maxAgeMs
      const pressure = count + reserveCount > this.limits.maxEntries || bytes + reserveBytes > this.limits.maxBytes
      if (outsideWindow && (expired || pressure)) {
        bytes -= Buffer.byteLength(JSON.stringify(key)) + 1 + size(entry) + (count > 1 ? 1 : 0)
        count--; delete this.entries[key]
      }
    }
  }
  reserve(key, hash) {
    if (typeof key !== 'string' || !key || key.length > 1024 || typeof hash !== 'string' || !hash || hash.length > 256) throw new ProtocolError('invalid_request_key', 'Invalid idempotency key')
    if (this.get(key)) throw new ProtocolError('request_conflict', 'Request id is already reserved; inspect its recorded outcome', 409)
    const entry = { hash, state: 'running', at: this.now() }
    const additional = size({ [key]: entry }) - 1 + FAILURE_RESERVE_BYTES
    this.compact(additional, 1)
    if (Object.keys(this.entries).length + 1 > this.limits.maxEntries || this.reservedBytes() + additional > this.limits.maxBytes) throw capacityError()
    this.entries[key] = entry
    return this.persist()
  }
  complete(key, result, { omitResult = false } = {}) {
    const entry = this.get(key)
    if (!entry || entry.state !== 'running') throw new Error('Missing active request reservation')
    const serialized = JSON.stringify(result)
    const next = { ...entry, state: 'done', at: this.now(), ...(!omitResult && Buffer.byteLength(serialized || '') <= this.limits.maxResultBytes ? { result } : { omitted: true }) }
    this.entries[key] = next
    // Room reserved by other running requests belongs to their final errors.
    if (this.reservedBytes() > this.limits.maxBytes) { delete next.result; next.omitted = true }
    return this.persist()
  }
  fail(key, error) {
    const entry = this.get(key)
    if (!entry) throw new Error('Missing request reservation')
    // Only a classified protocol rejection is known not to have an unknown
    // application side effect; unexpected failures remain fail-closed.
    const next = error instanceof ProtocolError
      ? { hash: entry.hash, at: this.now(), state: 'failed', error: { code: String(error.code).slice(0, 80), message: String(error.message).slice(0, 512), status: error.status } }
      : { hash: entry.hash, at: this.now(), state: 'unknown' }
    if (next.error) {
      const budget = size({ hash: entry.hash, at: entry.at, state: 'running' }) + FAILURE_RESERVE_BYTES
      while (size(next) > budget && next.error.message.length) next.error.message = next.error.message.slice(0, -1)
      while (size(next) > budget && next.error.code.length > 1) next.error.code = next.error.code.slice(0, -1)
    }
    this.entries[key] = next
    return this.persist()
  }
  persist() { const snapshot = JSON.stringify(this.entries); const operation = this.chain.then(() => writePrivateFile(this.file, snapshot)); this.chain = operation.catch(() => {}); return operation }
  stats() { return { ...this.limits, retryWindowMs: REQUEST_WINDOW_MS, entries: Object.keys(this.entries).length, uncertain: Object.values(this.entries).filter(item => ['running', 'unknown'].includes(item.state)).length, bytes: size(this.entries), reservedBytes: this.reservedBytes() } }
  async close() { await this.chain }
}
