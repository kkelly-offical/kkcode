import path from 'node:path'
import { constants } from 'node:fs'
import { createInterface } from 'node:readline'
import { readdir, lstat, open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { writePrivateFile } from '../storage/private-file.mjs'
import { ProtocolError, PROTOCOL_VERSION } from '../protocol/index.mjs'

export const REPLAY_DEFAULTS = Object.freeze({ maxEvents: 2000, sessionBytes: 8 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, maxAgeMs: 7 * 86400000, maxEventBytes: 512 * 1024, maxResponseBytes: 4 * 1024 * 1024 })
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)
const storageError = () => new ProtocolError('replay_storage', 'Replay storage must contain private regular files, not links', 409)

/** Valid IDs prevent path traversal. Pin the actual inode as well so a replaced
 * private-state entry cannot redirect replay reads/appends into another file.
 * State-directory ownership remains a local OS-user responsibility.
 */
async function openReplayFile(file, { append = false, maxBytes } = {}) {
  const before = await lstat(file, { bigint: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (!before && !append) return null
  if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)) throw storageError()
  const mode = append ? constants.O_WRONLY | constants.O_APPEND | (before ? 0 : constants.O_CREAT | constants.O_EXCL) : constants.O_RDONLY
  const handle = await open(file, mode | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0), 0o600)
  try {
    const info = await handle.stat({ bigint: true }), current = await lstat(file, { bigint: true })
    if (!info.isFile() || info.nlink !== 1n || current.isSymbolicLink() || info.ino !== current.ino || info.dev !== current.dev || before && (info.ino !== before.ino || info.dev !== before.dev) || maxBytes != null && info.size > BigInt(maxBytes)) throw storageError()
    return { handle, info }
  } catch (error) { await handle.close(); throw error }
}

/** Bounded transport replay, independent of canonical conversation history. */
export class ReplayStore {
  constructor(directory, { now = Date.now, ...limits } = {}) {
    this.directory = directory; this.now = now; this.limits = { ...REPLAY_DEFAULTS, ...limits }
    for (const name of Object.keys(REPLAY_DEFAULTS)) if (!Number.isSafeInteger(this.limits[name]) || this.limits[name] < 0) throw new TypeError(`Invalid event replay limit: ${name}`)
    this.states = new Map(); this.chain = Promise.resolve()
  }
  file(id) { if (!validId(id)) throw new ProtocolError('invalid_session', 'Invalid session id'); return path.join(this.directory, `events-${id}.jsonl`) }
  meta(id) { this.file(id); return path.join(this.directory, `cursor-${id}.json`) }
  async initialize() {
    for (const file of await readdir(this.directory)) {
      const match = /^(?:events-([A-Za-z0-9_-]{1,128})\.jsonl|cursor-([A-Za-z0-9_-]{1,128})\.json)$/.exec(file)
      if (match) await this.load(match[1] || match[2])
    }
    await this.enforceQuota()
    return this
  }
  async load(id) {
    if (this.states.has(id)) return this.states.get(id)
    const file = this.file(id), state = { cursor: 0, rows: [], bytes: 0, updatedAt: 0, needsRewrite: false }
    try {
      const cursor = await openReplayFile(this.meta(id), { maxBytes: 4096 })
      if (cursor) {
        try {
          const saved = JSON.parse(await cursor.handle.readFile('utf8'))
          if (!Number.isSafeInteger(saved.cursor) || saved.cursor < 0) throw new Error('Invalid replay high-water mark')
          state.cursor = saved.cursor
        } finally { await cursor.handle.close() }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    const journal = await openReplayFile(file), info = journal?.info
    if (journal) {
      const lines = createInterface({ input: journal.handle.createReadStream({ autoClose: false }), crlfDelay: Infinity })
      let previous = 0
      try {
      for await (const line of lines) {
        let row; try { row = JSON.parse(line) } catch { continue }
        if (!Number.isSafeInteger(row.seq) || row.seq <= 0) continue
        state.cursor = Math.max(state.cursor, row.seq)
        if (row.seq <= previous) continue
        previous = row.seq
        if (!Number.isFinite(row.timestamp) || row.sessionId !== id) continue
        state.updatedAt = Math.max(state.updatedAt, row.timestamp)
        const bytes = Buffer.byteLength(JSON.stringify(row)) + 1
        if (bytes > this.limits.maxEventBytes || row.timestamp < this.now() - this.limits.maxAgeMs) continue
        state.rows.push({ row, bytes }); state.bytes += bytes
        this.trim(state)
      }
      } finally { lines.close(); await journal.handle.close() }
    }
    this.states.set(id, state)
    if (info && BigInt(state.bytes) !== info.size) await this.rewrite(id, state)
    return state
  }
  trim(state) {
    const threshold = this.now() - this.limits.maxAgeMs
    const kept = state.rows.filter(item => item.row.timestamp >= threshold)
    let changed = kept.length !== state.rows.length
    if (changed) { state.rows = kept; state.bytes = kept.reduce((sum, item) => sum + item.bytes, 0) }
    while (state.rows.length && (state.rows.length > this.limits.maxEvents || state.bytes > this.limits.sessionBytes)) {
      state.bytes -= state.rows.shift().bytes; changed = true
    }
    return changed
  }
  async rewrite(id, state) {
    // Persist the high-water mark before rotating; cursor numbers never reset.
    await writePrivateFile(this.meta(id), JSON.stringify({ cursor: state.cursor }))
    await writePrivateFile(this.file(id), state.rows.map(item => JSON.stringify(item.row)).join('\n') + (state.rows.length ? '\n' : ''))
    state.needsRewrite = false
  }
  async enforceQuota(keep = null, proposed = null) {
    let total = [...this.states].reduce((sum, [id, state]) => sum + (id === keep && proposed ? proposed.bytes : state.bytes), 0)
    for (const [id, current] of [...this.states].sort((a, b) => a[1].updatedAt - b[1].updatedAt)) {
      if (id === keep && proposed) continue
      const state = { ...current, rows: [...current.rows] }
      let changed = this.trim(state)
      const afterTrim = total - (current.bytes - state.bytes)
      if (afterTrim > this.limits.totalBytes && state.bytes) { state.bytes = 0; state.rows = []; changed = true }
      if (changed) {
        // Do not claim disk quota was freed until the replacement succeeds.
        await this.rewrite(id, state)
        total -= current.bytes - state.bytes; this.states.set(id, state)
      }
    }
    let changed = false
    if (proposed) while (proposed.rows.length && total > this.limits.totalBytes) {
      const removed = proposed.rows.shift(); total -= removed.bytes; proposed.bytes -= removed.bytes; changed = true
    }
    return changed
  }
  append(event) {
    const operation = this.chain.then(async () => {
      const id = event.sessionId, state = await this.load(id)
      if (state.cursor >= Number.MAX_SAFE_INTEGER) throw new ProtocolError('replay_cursor_exhausted', 'Event sequence exhausted; start a new session', 409)
      const row = { ...event, schemaVersion: PROTOCOL_VERSION, id: event.id || randomUUID(), seq: state.cursor + 1, timestamp: this.now() }
      let stored = row, line = JSON.stringify(row)
      if (Buffer.byteLength(line) + 1 > this.limits.maxEventBytes) { stored = { id: row.id, sessionId: id, seq: row.seq, timestamp: row.timestamp, schemaVersion: PROTOCOL_VERSION, type: 'replay.snapshot_required', payload: {} }; line = JSON.stringify(stored) }
      const bytes = Buffer.byteLength(line) + 1
      const next = { ...state, cursor: row.seq, rows: [...state.rows], updatedAt: row.timestamp }
      if (bytes <= this.limits.maxEventBytes) { next.rows.push({ row: stored, bytes }); next.bytes += bytes }
      let rotate = this.trim(next) || state.needsRewrite || bytes > this.limits.maxEventBytes
      // Free other journals before admitting bytes. A failed rotation must not
      // allow repeated appends to grow storage past the global quota.
      rotate = await this.enforceQuota(id, next) || rotate
      // Reserve sequence numbers before an append. A failed or partial write
      // becomes an explicit gap, never a reused cursor after a process restart.
      await writePrivateFile(this.meta(id), JSON.stringify({ cursor: row.seq }))
      state.cursor = row.seq
      try {
        if (rotate) await this.rewrite(id, next)
        else {
          const journal = await openReplayFile(this.file(id), { append: true })
          try { await journal.handle.appendFile(line + '\n') } finally { await journal.handle.close() }
        }
      } catch (error) { state.needsRewrite = true; throw error }
      this.states.set(id, next)
      return stored
    })
    this.chain = operation.catch(() => {})
    return operation
  }
  read(id, after = 0, limit = 1000) {
    const operation = this.chain.then(async () => {
    if (!Number.isSafeInteger(after) || after < 0) throw new ProtocolError('invalid_cursor', 'Event cursor must be a non-negative integer')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new ProtocolError('invalid_limit', 'Read between 1 and 1000 events at a time')
    const current = await this.load(id), state = { ...current, rows: [...current.rows] }
    if (this.trim(state)) { await this.rewrite(id, state); this.states.set(id, state) }
    const earliest = state.rows[0]?.row.seq || state.cursor + 1
    const available = state.rows.filter(item => item.row.seq > after)
    const rows = []; let responseBytes = 2, responseGap = false
    for (const item of available) {
      if (rows.length >= limit) break
      const bytes = Buffer.byteLength(JSON.stringify(item.row)) + (rows.length ? 1 : 0)
      if (responseBytes + bytes > this.limits.maxResponseBytes) { responseGap = rows.length === 0; break }
      rows.push(item.row); responseBytes += bytes
    }
    const discontinuity = rows.some((row, index) => index > 0 && row.seq !== rows[index - 1].seq + 1)
    const missingTail = available.length === rows.length && (rows.at(-1)?.seq ?? after) < state.cursor
    return { events: rows, earliest, cursor: state.cursor, gap: after > state.cursor || after < earliest - 1 || rows.length > 0 && rows[0].seq > after + 1 || discontinuity || missingTail || responseGap || rows.some(row => row.type === 'replay.snapshot_required') }
    })
    this.chain = operation.catch(() => {})
    return operation
  }
  clearSession(id) {
    const operation = this.chain.then(async () => {
      const state = await this.load(id)
      const next = { ...state, rows: [], bytes: 0, updatedAt: this.now() }
      await this.rewrite(id, next)
      this.states.set(id, next)
    })
    this.chain = operation.catch(() => {})
    return operation
  }
  stats() { return { ...this.limits, bytes: [...this.states.values()].reduce((sum, state) => sum + state.bytes, 0), journals: this.states.size } }
  async close() { await this.chain }
}
