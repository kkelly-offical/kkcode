import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import { ProtocolError } from '../protocol/index.mjs'
import { sniffImageMediaType } from '../kernel/index.mjs'

export const ATTACHMENT_LIMITS = Object.freeze({
  imageBytes: 4 * 1024 * 1024, textBytes: 256 * 1024,
  perTurn: 8, perSessionBytes: 16 * 1024 * 1024,
  deviceBytes: 64 * 1024 * 1024, entries: 256, retentionMs: 24 * 60 * 60 * 1000
})
export const ATTACHMENT_RPC_BYTES = 6 * 1024 * 1024
const sessionPattern = /^[A-Za-z0-9_-]{1,128}$/
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const textTypes = new Set(['application/json', 'application/xml', 'application/yaml', 'application/x-yaml', 'application/javascript', 'application/typescript', 'application/toml'])
const privateNames = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.git-credentials|credentials(?:\.[^.]*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i
const forbiddenSuffix = /\.(?:pem|key|p12|pfx|keystore|jks)$/i

function validateSession(id) {
  if (typeof id !== 'string' || !sessionPattern.test(id)) throw new ProtocolError('invalid_session', 'Invalid session id')
}
function metadata(record) {
  const { id, sessionId, name, mediaType, size, createdAt, expiresAt } = record
  return { id, sessionId, name, mediaType, size, createdAt, expiresAt }
}
function decodeUpload({ name, mediaType, data }, limits) {
  if (typeof name !== 'string' || !name.trim() || name.length > 180 || name === '.' || name === '..' || /[\\/\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(name)) throw new ProtocolError('invalid_attachment_name', 'Choose a plain file name without path components')
  if (privateNames.test(name) || forbiddenSuffix.test(name)) throw new ProtocolError('credential_attachment', 'Credential files cannot be uploaded', 403)
  if (typeof mediaType !== 'string') throw new ProtocolError('attachment_type', 'Specify the file media type')
  mediaType = mediaType.toLowerCase().split(';')[0].trim()
  const image = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mediaType)
  if (!image && !(/^text\/[a-z0-9.+-]+$/.test(mediaType) || textTypes.has(mediaType))) throw new ProtocolError('attachment_type', 'Upload PNG, JPEG, GIF, WebP or UTF-8 text files')
  const max = image ? limits.imageBytes : limits.textBytes
  if (typeof data !== 'string' || !data || data.length > Math.ceil(max / 3) * 4) throw new ProtocolError('attachment_size', `File must contain 1–${max} bytes`, 413)
  if (data.length % 4 || /[^A-Za-z0-9+/=]/.test(data)) throw new ProtocolError('attachment_encoding', 'Attachment data must be canonical base64')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > max || bytes.toString('base64') !== data) throw new ProtocolError('attachment_encoding', 'Invalid or oversized attachment data')
  if (image) {
    if (sniffImageMediaType(bytes) !== mediaType) throw new ProtocolError('attachment_type', 'Image content does not match its declared format')
  } else {
    let text
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new ProtocolError('attachment_encoding', 'Text attachments must use UTF-8') }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new ProtocolError('attachment_type', 'Binary content cannot be uploaded as text')
  }
  return { name, mediaType, data, size: bytes.length }
}

/** Private staging only. Resolved content is copied into canonical kernel history.
 * No client name/path is ever used as a filesystem location. All operations are
 * serialized, so concurrent uploads cannot evade quotas or remove a pinned turn.
 */
export class AttachmentStore {
  constructor({ directory, limits = ATTACHMENT_LIMITS, now = Date.now }) {
    this.directory = path.resolve(directory); this.limits = { ...ATTACHMENT_LIMITS, ...limits }
    this.now = now; this.records = new Map(); this.pins = new Map(); this.chain = Promise.resolve()
  }
  exclusive(operation) {
    const work = this.chain.catch(() => {}).then(operation)
    this.chain = work
    return work
  }
  async checkDirectory() {
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(this.directory) !== this.realDirectory) throw new ProtocolError('attachment_storage', 'Attachment storage is not a private directory', 500)
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    this.realDirectory = await realpath(this.directory)
    await this.checkDirectory()
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || !idPattern.test(entry.name.slice(0, -5))) continue
      try {
        const record = await this.read(entry.name.slice(0, -5))
        if (!sessionPattern.test(record.sessionId) || record.id !== entry.name.slice(0, -5) || !Number.isFinite(record.expiresAt)) continue
        const valid = decodeUpload(record, this.limits)
        if (record.size !== valid.size) continue
        this.records.set(record.id, metadata(record))
      } catch { /* Corrupt/untrusted entries are never passed to the model. */ }
    }
    await this.prune()
    return this
  }
  async read(id) {
    if (!idPattern.test(id)) throw new ProtocolError('attachment_missing', 'Attachment not found', 404)
    await this.checkDirectory()
    const location = path.join(this.directory, `${id}.json`), before = await lstat(location)
    if (!before.isFile() || before.isSymbolicLink()) throw new ProtocolError('attachment_storage', 'Attachment payload is not a regular file')
    const file = await open(location, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > ATTACHMENT_RPC_BYTES) throw new ProtocolError('attachment_storage', 'Invalid attachment storage')
      return JSON.parse(await file.readFile('utf8'))
    } finally { await file.close() }
  }
  async prune() {
    await this.checkDirectory()
    for (const [id, record] of this.records) if (record.expiresAt <= this.now() && !this.pins.has(id)) {
      await unlink(path.join(this.directory, `${id}.json`)).catch(error => { if (error.code !== 'ENOENT') throw error })
      this.records.delete(id)
    }
  }
  upload(input) {
    return this.exclusive(async () => {
      validateSession(input.sessionId)
      const decoded = decodeUpload(input, this.limits)
      await this.prune()
      let total = 0, sessionBytes = 0
      for (const record of this.records.values()) { total += record.size; if (record.sessionId === input.sessionId) sessionBytes += record.size }
      if (this.records.size >= this.limits.entries || total + decoded.size > this.limits.deviceBytes || sessionBytes + decoded.size > this.limits.perSessionBytes) throw new ProtocolError('attachment_quota', 'Attachment staging is full; remove unused attachments or wait for expiry', 413)
      const now = this.now(), record = { id: randomUUID(), sessionId: input.sessionId, ...decoded, createdAt: now, expiresAt: now + this.limits.retentionMs }
      const file = await open(path.join(this.directory, `${record.id}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600)
      try { await file.writeFile(JSON.stringify(record)); await file.sync() } finally { await file.close() }
      this.records.set(record.id, metadata(record))
      return metadata(record)
    })
  }
  list({ sessionId }) {
    return this.exclusive(async () => {
      validateSession(sessionId); await this.prune()
      return { attachments: [...this.records.values()].filter(record => record.sessionId === sessionId), limits: this.limits }
    })
  }
  remove({ sessionId, id }) {
    return this.exclusive(async () => {
      validateSession(sessionId); await this.checkDirectory()
      const record = this.records.get(id)
      if (!record || record.sessionId !== sessionId) throw new ProtocolError('attachment_missing', 'Attachment not found in this session', 404)
      if (this.pins.has(id)) throw new ProtocolError('attachment_busy', 'This attachment is being used by a running turn', 409)
      await unlink(path.join(this.directory, `${id}.json`)).catch(error => { if (error.code !== 'ENOENT') throw error })
      this.records.delete(id)
      return { removed: true }
    })
  }
  resolve({ sessionId, ids = [], prompt }) {
    return this.exclusive(async () => {
      validateSession(sessionId)
      if (!Array.isArray(ids) || ids.length > this.limits.perTurn || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !idPattern.test(id))) throw new ProtocolError('attachment_ids', `Choose up to ${this.limits.perTurn} different attachments`)
      await this.prune()
      const attachments = [], contentBlocks = [{ type: 'text', text: prompt }]
      for (const id of ids) {
        const known = this.records.get(id)
        if (!known || known.sessionId !== sessionId) throw new ProtocolError('attachment_missing', 'Attachment not found in this session', 404)
        const record = await this.read(id)
        if (record.id !== id || record.sessionId !== sessionId || record.size !== known.size) throw new ProtocolError('attachment_storage', 'Attachment metadata changed; upload the file again', 409)
        decodeUpload(record, this.limits)
        attachments.push(metadata(record))
        contentBlocks.push({ type: 'text', text: `Attached file: ${record.name}` })
        contentBlocks.push(record.mediaType.startsWith('image/')
          ? { type: 'image', data: record.data, mediaType: record.mediaType }
          : { type: 'text', text: Buffer.from(record.data, 'base64').toString('utf8') })
      }
      for (const id of ids) this.pins.set(id, (this.pins.get(id) || 0) + 1)
      let released = false
      return { contentBlocks: ids.length ? contentBlocks : null, attachments, release: () => this.exclusive(async () => {
        if (released) return
        released = true
        for (const id of ids) { const count = this.pins.get(id) || 0; if (count > 1) this.pins.set(id, count - 1); else this.pins.delete(id) }
        await this.prune()
      }) }
    })
  }
}
