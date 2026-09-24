import { constants, lstatSync, realpathSync } from 'node:fs'
import { mkdir, lstat, readdir, open, rename, unlink, link } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { acquireProcessLock } from './process-lock.mjs'
import { userRootDir } from './paths.mjs'

/** @typedef {{accountId: string, projectId: string, sessionId: string, runId: string}} ArtifactActor */
/** @typedef {{kind: 'tool'|'web'|'document'|'user'|'system', toolCallId?: string, messageId?: string, operationId?: string}} ArtifactSource */
/** @typedef {{actor: ArtifactActor, id: string}} ArtifactIdentity */
/** @typedef {{actor: ArtifactActor, content: string|Uint8Array|AsyncIterable<string|Uint8Array>, mime?: string, source?: ArtifactSource, signal?: AbortSignal}} ArtifactPutInput */
/** @typedef {ArtifactIdentity & {cursor?: string, limit?: number}} ArtifactReadInput */
/** @typedef {ArtifactIdentity & {query: string, cursor?: string, maxBytes?: number, maxMatches?: number}} ArtifactSearchInput */
/** @typedef {{actor: ArtifactActor, cursor?: string, limit?: number}} ArtifactListInput */
/** @typedef {ArtifactIdentity & {active?: boolean, resolved?: boolean, references?: string[]}} ArtifactRetentionInput */

export const ARTIFACT_LIMITS = Object.freeze({
  fileBytes: 128 * 1024 * 1024,
  runBytes: 1024 * 1024 * 1024,
  deviceBytes: 10 * 1024 * 1024 * 1024,
  retentionMs: 30 * 24 * 60 * 60 * 1000,
  pageBytes: 64 * 1024,
  searchBytes: 8 * 1024 * 1024,
  lockTimeoutMs: 30_000
})
const ID = /^art_[0-9a-f-]{36}$/
const SCOPE_KEYS = ['accountId', 'projectId', 'sessionId', 'runId']
const OPAQUE = /^[a-zA-Z0-9_.:@-]{1,160}$/
const HASH = /^[0-9a-f]{64}$/
const MAX_CATALOG_BYTES = 32 * 1024 * 1024
const MAX_PAGE_BYTES = 1024 * 1024
const MAX_SEARCH_BYTES = 64 * 1024 * 1024

export class ArtifactStoreError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'ArtifactStoreError'
    this.code = code
    this.status = status
  }
}
const fail = (code, message, status) => { throw new ArtifactStoreError(code, message, status) }
const invalid = message => fail('artifact_invalid', message)
const corrupt = () => fail('artifact_corrupt', '产物记录或文件不完整，请在本机检查后恢复；未自动覆盖原记录。', 409)
const unsafe = () => fail('artifact_unsafe_storage', '产物目录、文件权限或链接状态不安全，已停止访问。', 409)
const clone = value => structuredClone(value)

function scopeOf(actor) {
  if (!actor || SCOPE_KEYS.some(key => typeof actor[key] !== 'string' || !OPAQUE.test(actor[key]))) {
    invalid('必须提供由宿主验证的账号、项目、会话和任务范围标识。')
  }
  return Object.fromEntries(SCOPE_KEYS.map(key => [key, actor[key]]))
}

function sameScope(left, right) { return SCOPE_KEYS.every(key => left[key] === right[key]) }
function sourceOf(source = { kind: 'tool' }) {
  const allowed = ['kind', 'toolCallId', 'messageId', 'operationId']
  if (!source || Object.keys(source).some(key => !allowed.includes(key)) ||
      !['tool', 'web', 'document', 'user', 'system'].includes(source.kind) ||
      allowed.slice(1).some(key => source[key] !== undefined && (typeof source[key] !== 'string' || !OPAQUE.test(source[key])))) {
    invalid('产物来源只接受来源种类和不含凭据的内部标识，不接受 URL、请求头或主机路径。')
  }
  return clone(source)
}

function checkedId(id) {
  if (typeof id !== 'string' || !ID.test(id)) invalid('产物标识格式无效。')
  return id
}

function canonicalStoreRoot(root) {
  const absolute = path.resolve(root)
  // The host selects the parent, whose OS aliases (/var on macOS, for
  // example) may be resolved once. The actual store itself must not be a link.
  try { if (lstatSync(absolute).isSymbolicLink()) unsafe() } catch (error) { if (error.code !== 'ENOENT') throw error }
  const suffix = [path.basename(absolute)]
  let parent = path.dirname(absolute)
  for (;;) {
    try { return path.join(realpathSync.native(parent), ...suffix) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const next = path.dirname(parent)
      if (next === parent) throw error
      suffix.unshift(path.basename(parent))
      parent = next
    }
  }
}

function privateStat(info, directory = false, allowLockLink = false) {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) unsafe()
  if (!directory && info.nlink !== 1 && !(allowLockLink && info.nlink === 2)) unsafe()
  if (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid()))) unsafe()
}

// Node does not expose openat: reject linked ancestors and use an owner-only
// root, then O_NOFOLLOW and inode checks for every file. This is not a sandbox
// against arbitrary code already running as the same OS user.
async function ensureDirectory(directory, privateDirectory = true) {
  const absolute = path.resolve(directory)
  const parts = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean)
  let current = path.parse(absolute).root
  for (const part of parts) {
    current = path.join(current, part)
    try { await mkdir(current, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) unsafe()
  }
  if (privateDirectory) privateStat(await lstat(absolute), true)
}

async function safeOpen(file, flags = constants.O_RDONLY) {
  const before = await lstat(file)
  privateStat(before)
  const handle = await open(file, flags | (constants.O_NOFOLLOW || 0))
  try {
    const after = await handle.stat()
    privateStat(after)
    if (before.ino !== after.ino || before.dev !== after.dev) unsafe()
    return handle
  } catch (error) { await handle.close(); throw error }
}

async function safeRead(file, maxBytes) {
  const handle = await safeOpen(file)
  try {
    if ((await handle.stat()).size > maxBytes) corrupt()
    return await handle.readFile('utf8')
  } finally { await handle.close() }
}

async function syncDirectory(directory) {
  // Windows does not support opening directory handles for fsync.
  if (process.platform === 'win32') return
  const handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY || 0))
  try { await handle.sync() } finally { await handle.close() }
}

async function publishJson(file, data) {
  const content = JSON.stringify(data)
  if (Buffer.byteLength(content) > MAX_CATALOG_BYTES) fail('artifact_catalog_full', '产物索引已达到安全容量，请归档后重试。', 507)
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
    await handle.close()
    await rename(temporary, file)
    await syncDirectory(path.dirname(file))
  } finally {
    await handle.close().catch(() => {})
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}

function cursorEncode(value) { return Buffer.from(JSON.stringify(value)).toString('base64url') }
function cursorDecode(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) invalid('产物分页游标无效。')
  let parsed
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) } catch { invalid('产物分页游标无效。') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid('产物分页游标无效。')
  return parsed
}

async function* inputChunks(content, signal) {
  if (typeof content === 'string' || content instanceof Uint8Array) { yield content; return }
  const iterator = content[Symbol.asyncIterator]()
  let complete = false
  try {
    for (;;) {
      signal?.throwIfAborted()
      let removeAbort = () => {}
      try {
        const next = Promise.resolve().then(() => iterator.next())
        const result = signal ? await Promise.race([next, new Promise((_, reject) => {
          const abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          removeAbort = () => signal.removeEventListener('abort', abort)
          if (signal.aborted) abort()
        })]) : await next
        if (result.done) { complete = true; return }
        yield result.value
      } finally { removeAbort() }
    }
  } finally {
    if (!complete && iterator.return) {
      // Teardown belongs to an untrusted producer. It may stall after a quota
      // error just as it may after cancellation, so it must NEVER own the
      // store lock lifetime. Ask it to close and observe any rejection, while
      // the put() finally closes our handle and removes the partial payload.
      Promise.resolve().then(() => iterator.return()).catch(() => {})
    }
  }
}
function offsetOf(cursor, metadata, kind) {
  if (!cursor) return 0
  const parsed = cursorDecode(cursor)
  if (parsed.kind !== kind || parsed.id !== metadata.id || parsed.sha256 !== metadata.sha256 ||
      !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || parsed.offset > metadata.size) {
    fail('artifact_cursor_stale', '分页游标不属于当前产物快照，请从第一页重新读取。', 409)
  }
  return parsed.offset
}

function validateRecord(record, id) {
  try {
    if (!record || record.id !== id || !ID.test(id) || record.schemaVersion !== 1 ||
        !HASH.test(record.sha256) || !Number.isSafeInteger(record.size) || record.size < 0 ||
        typeof record.mime !== 'string' || !Number.isSafeInteger(record.createdAt) ||
        !record.retention || typeof record.retention.active !== 'boolean' ||
        (record.retention.retired !== undefined && typeof record.retention.retired !== 'boolean') ||
        typeof record.retention.resolved !== 'boolean' || typeof record.retention.pinned !== 'boolean' ||
        !Number.isSafeInteger(record.retention.updatedAt) || !Array.isArray(record.retention.references) ||
        record.retention.references.some(value => typeof value !== 'string' || !OPAQUE.test(value))) corrupt()
    scopeOf(record.scope)
    sourceOf(record.source)
  } catch { corrupt() }
}

function publicMetadata(record) {
  return clone({ schemaVersion: record.schemaVersion, id: record.id, sha256: record.sha256, size: record.size,
    mime: record.mime, createdAt: record.createdAt, scope: record.scope, source: record.source,
    retention: record.retention })
}

/** Local owner-controlled immutable payload storage; actors MUST be host-derived,
 * never copied from untrusted RPC arguments. No API returns host filesystem paths. */
export class ArtifactStore {
  constructor({ root = path.join(userRootDir(), 'artifacts'), limits = {}, clock = Date.now } = {}) {
    this.root = canonicalStoreRoot(root)
    this.objects = path.join(this.root, 'objects')
    this.temporary = path.join(this.root, 'pending')
    this.quarantine = path.join(this.root, 'quarantine')
    this.catalogFile = path.join(this.root, 'catalog.json')
    this.lockFile = path.join(this.root, 'catalog.lock')
    this.clock = clock
    this.verifiedSnapshots = new Map()
    this.limits = { ...ARTIFACT_LIMITS, ...limits }
    if (Object.keys(limits).some(key => !(key in ARTIFACT_LIMITS)) ||
        Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value <= 0) ||
        this.limits.pageBytes > MAX_PAGE_BYTES || this.limits.searchBytes > MAX_SEARCH_BYTES) invalid('产物容量配置无效。')
  }

  async _locked(callback, signal, readCatalog = true) {
    await ensureDirectory(this.root)
    await ensureDirectory(this.objects)
    await ensureDirectory(this.temporary)
    const start = Date.now()
    let lock
    while (!lock) {
      signal?.throwIfAborted()
      for (const file of [this.lockFile, `${this.lockFile}.recovery`]) {
        try { privateStat(await lstat(file), file.endsWith('.recovery'), file === this.lockFile) } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      try { lock = await acquireProcessLock(this.lockFile) } catch (error) {
        if (error.code !== 'device_in_use') throw error
        if (Date.now() - start >= this.limits.lockTimeoutMs) fail('artifact_busy', '产物存储正在使用或锁状态需要本机检查，请稍后重试。', 409)
        await delay(10, undefined, { signal })
      }
    }
    try {
      const catalog = readCatalog ? await this._catalog() : null
      return await callback(catalog)
    } finally { await lock.release() }
  }

  async _catalog() {
    let raw
    try { raw = await safeRead(this.catalogFile, MAX_CATALOG_BYTES) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      if ((await readdir(this.objects)).length || (await readdir(this.temporary)).length) corrupt()
      return { schemaVersion: 1, revision: randomUUID(), records: {} }
    }
    let catalog
    try { catalog = JSON.parse(raw) } catch { corrupt() }
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog) || catalog.schemaVersion !== 1 || typeof catalog.revision !== 'string' ||
        !catalog.records || Array.isArray(catalog.records) || typeof catalog.records !== 'object') corrupt()
    for (const [id, record] of Object.entries(catalog.records)) validateRecord(record, id)
    return catalog
  }

  async _commit(catalog) {
    catalog.revision = randomUUID()
    await publishJson(this.catalogFile, catalog)
  }

  _authorized(catalog, id, actor) {
    checkedId(id)
    const scope = scopeOf(actor)
    const record = catalog.records[id]
    if (!record || !sameScope(record.scope, scope)) fail('artifact_not_found', '该产物不存在，或不属于当前账号、项目、会话和任务。', 404)
    return record
  }

  async _verifiedHandle(record) {
    let handle
    try { handle = await safeOpen(path.join(this.objects, `${record.id}.bin`)) } catch (error) {
      if (error.code === 'ENOENT') fail('artifact_missing', '产物原文已缺失，不能视为完整结果；请恢复备份或重新生成。', 410)
      throw error
    }
    try {
      const before = await handle.stat({ bigint: true })
      if (before.size !== BigInt(record.size)) corrupt()
      const signature = [record.sha256, before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].join(':')
      // A page reader should not hash a 128 MiB payload anew for each 64 KiB
      // page. Cache only verified OS snapshots; changes invalidate the proof.
      if (this.verifiedSnapshots.get(record.id) === signature) return handle
      const hash = createHash('sha256')
      const buffer = Buffer.alloc(64 * 1024)
      let position = 0
      while (position < record.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, record.size - position), position)
        if (!bytesRead) corrupt()
        hash.update(buffer.subarray(0, bytesRead))
        position += bytesRead
      }
      if (hash.digest('hex') !== record.sha256) corrupt()
      const after = await handle.stat({ bigint: true })
      if ([record.sha256, after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(':') !== signature) corrupt()
      if (this.verifiedSnapshots.size >= 256) this.verifiedSnapshots.delete(this.verifiedSnapshots.keys().next().value)
      this.verifiedSnapshots.set(record.id, signature)
      return handle
    } catch (error) { await handle.close(); throw error }
  }

  async _usage(catalog, scope) {
    let device = 0, orphanBytes = 0
    for (const directory of [this.objects, this.temporary, this.quarantine]) {
      let names
      try { names = await readdir(directory); privateStat(await lstat(directory), true) } catch (error) { if (error.code === 'ENOENT' && directory === this.quarantine) continue; throw error }
      for (const name of names) {
        const pattern = directory === this.objects ? /^art_[0-9a-f-]{36}\.bin$/ : directory === this.temporary ? /^[0-9a-f-]{36}\.part$/ : /^recovery_[0-9a-f-]{36}\.(blob|json)$/
        if (!pattern.test(name)) corrupt()
        const info = await lstat(path.join(directory, name))
        privateStat(info)
        device += info.size
        if (directory !== this.objects || !catalog.records[name.slice(0, -4)]) orphanBytes += info.size
      }
    }
    const run = Object.values(catalog.records).filter(record => ['accountId', 'projectId', 'runId'].every(key => record.scope[key] === scope[key])).reduce((sum, record) => sum + record.size, 0)
    // An interrupted upload has no trustworthy owner metadata. Charge its
    // bytes conservatively to each run until a local repair resolves it.
    return { device, run: run + orphanBytes }
  }

  /** @param {Partial<ArtifactPutInput>} [input] */
  async put({ actor, content, mime = 'application/octet-stream', source, signal } = {}) {
    const scope = scopeOf(actor), origin = sourceOf(source)
    if (typeof mime !== 'string' || mime.length > 200 || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:; charset=[\w-]+)?$/.test(mime)) invalid('产物 MIME 类型无效。')
    if (!(typeof content === 'string' || content instanceof Uint8Array || content?.[Symbol.asyncIterator])) invalid('产物内容必须为文本、字节或异步字节流。')
    return this._locked(async catalog => {
      // Persist an empty catalog first, so a crash during the first upload leaves
      // a recoverable orphan rather than ambiguous missing metadata.
      try { await lstat(this.catalogFile) } catch (error) { if (error.code !== 'ENOENT') throw error; await this._commit(catalog) }
      const usage = await this._usage(catalog, scope)
      const id = `art_${randomUUID()}`
      const temporary = path.join(this.temporary, `${randomUUID()}.part`)
      const destination = path.join(this.objects, `${id}.bin`)
      const handle = await open(temporary, 'wx', 0o600)
      let published = false, size = 0
      const hash = createHash('sha256')
      try {
        for await (const chunk of inputChunks(content, signal)) {
          signal?.throwIfAborted()
          if (!(typeof chunk === 'string' || chunk instanceof Uint8Array)) invalid('产物流包含非字节内容。')
          size += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
          if (size > this.limits.fileBytes || usage.run + size > this.limits.runBytes || usage.device + size > this.limits.deviceBytes) {
            fail('artifact_quota_exceeded', '产物达到文件、任务或设备容量限制；原结果未作为完整产物发布。', 413)
          }
          const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
          hash.update(bytes)
          let offset = 0
          while (offset < bytes.byteLength) {
            const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset)
            if (!bytesWritten) throw new Error('Artifact write made no progress')
            offset += bytesWritten
          }
        }
        signal?.throwIfAborted()
        await handle.sync()
        await handle.close()
        await link(temporary, destination)
        await unlink(temporary)
        published = true
        await syncDirectory(this.objects)
        await syncDirectory(this.temporary)
        const now = this.clock()
        const record = { schemaVersion: 1, id, sha256: hash.digest('hex'), size, mime, scope, source: origin, createdAt: now,
          retention: { pinned: false, active: true, resolved: false, references: [], updatedAt: now } }
        catalog.records[id] = record
        await this._commit(catalog)
        return publicMetadata(record)
      } finally {
        await handle.close().catch(() => {})
        if (!published) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
        // Published but unindexed data is deliberately retained and counted in
        // device quota if metadata fsync fails; never silently discard evidence.
      }
    }, signal)
  }

  /** @param {Partial<ArtifactIdentity>} [input] */
  async getMetadata({ actor, id } = {}) {
    return this._locked(async catalog => {
      const record = this._authorized(catalog, id, actor)
      const handle = await this._verifiedHandle(record)
      await handle.close()
      return publicMetadata(record)
    })
  }

  /** @param {Partial<ArtifactReadInput>} [input] */
  async read({ actor, id, cursor, limit = this.limits.pageBytes } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_BYTES) invalid('产物读取页大小无效。')
    return this._locked(async catalog => {
      const record = this._authorized(catalog, id, actor)
      const offset = offsetOf(cursor, record, 'read')
      const handle = await this._verifiedHandle(record)
      try {
        const size = Math.min(limit, record.size - offset)
        // Allocation capacities are fixed constants, not request-derived sizes.
        // Keep the existing 1 MiB page ceiling explicit at the allocation site;
        // small pages use smaller buckets, and only actual bytes are returned.
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_PAGE_BYTES) invalid('产物读取页大小无效。')
        const buffer = size === 0 ? Buffer.alloc(0) : size <= 4096 ? Buffer.alloc(4096)
          : size <= 65536 ? Buffer.alloc(65536) : size <= 262144 ? Buffer.alloc(262144) : Buffer.alloc(1048576)
        const { bytesRead } = await handle.read(buffer, 0, size, offset)
        if (bytesRead !== size) corrupt()
        const next = offset + bytesRead
        return { id, sha256: record.sha256, size: record.size, offset, encoding: 'base64', data: buffer.subarray(0, bytesRead).toString('base64'),
          nextCursor: next < record.size ? cursorEncode({ kind: 'read', id, sha256: record.sha256, offset: next }) : null }
      } finally { await handle.close() }
    })
  }

  /** @param {Partial<ArtifactSearchInput>} [input] */
  async search({ actor, id, query, cursor, maxBytes = this.limits.searchBytes, maxMatches = 100 } = {}) {
    if (typeof query !== 'string' || !query.length || Buffer.byteLength(query) > 1024 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < Buffer.byteLength(query) || maxBytes > MAX_SEARCH_BYTES ||
        !Number.isSafeInteger(maxMatches) || maxMatches < 1 || maxMatches > 1000) invalid('产物搜索参数无效。')
    return this._locked(async catalog => {
      const record = this._authorized(catalog, id, actor)
      const queryHash = createHash('sha256').update(query).digest('hex')
      if (cursor && cursorDecode(cursor).queryHash !== queryHash) fail('artifact_cursor_stale', '搜索条件已改变，请重新搜索。', 409)
      const offset = offsetOf(cursor, record, 'search')
      const handle = await this._verifiedHandle(record)
      try {
        const needle = Buffer.from(query)
        const span = Math.min(maxBytes, record.size - offset)
        // One bounded buffer, plus overlap, keeps matches crossing pages intact.
        const buffer = Buffer.alloc(Math.min(span + needle.length - 1, record.size - offset))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
        if (bytesRead !== buffer.length) corrupt()
        const matches = []
        let position = 0, consumed = span
        while (position < span) {
          const found = buffer.indexOf(needle, position)
          if (found < 0 || found >= span) break
          matches.push({ offset: offset + found, length: needle.length,
            readCursor: cursorEncode({ kind: 'read', id, sha256: record.sha256, offset: offset + found }) })
          position = found + 1
          if (matches.length === maxMatches) { consumed = position; break }
        }
        const next = offset + consumed
        return { id, sha256: record.sha256, matches, scannedBytes: consumed,
          nextCursor: next < record.size ? cursorEncode({ kind: 'search', id, sha256: record.sha256, queryHash, offset: next }) : null }
      } finally { await handle.close() }
    })
  }

  /** @param {Partial<ArtifactListInput>} [input] */
  async list({ actor, cursor, limit = 100 } = {}) {
    const scope = scopeOf(actor)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) invalid('产物列表页大小无效。')
    return this._locked(async catalog => {
      const scopeHash = createHash('sha256').update(JSON.stringify(scope)).digest('hex')
      let offset = 0
      if (cursor) {
        const page = cursorDecode(cursor)
        if (page.kind !== 'list' || page.revision !== catalog.revision || page.scopeHash !== scopeHash || !Number.isSafeInteger(page.offset) || page.offset < 0) {
          fail('artifact_cursor_stale', '产物列表已变化，请从第一页重新读取。', 409)
        }
        offset = page.offset
      }
      const records = Object.values(catalog.records).filter(record => sameScope(record.scope, scope)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      const items = records.slice(offset, offset + limit).map(publicMetadata)
      return { items, nextCursor: offset + items.length < records.length ? cursorEncode({ kind: 'list', revision: catalog.revision, scopeHash, offset: offset + items.length }) : null }
    })
  }

  /** @param {Partial<ArtifactRetentionInput>} [input] */
  async setRetention({ actor, id, active, resolved, references } = {}) {
    if ((active !== undefined && typeof active !== 'boolean') || (resolved !== undefined && typeof resolved !== 'boolean') ||
        (references !== undefined && (!Array.isArray(references) || references.length > 1000 || references.some(value => typeof value !== 'string' || !OPAQUE.test(value))))) invalid('产物保留状态无效。')
    return this._locked(async catalog => {
      const record = this._authorized(catalog, id, actor)
      const next = { ...record.retention, ...(active === undefined ? {} : { active }), ...(resolved === undefined ? {} : { resolved }),
        ...(references === undefined ? {} : { references: [...new Set(references)].sort() }) }
      if (JSON.stringify(next) !== JSON.stringify(record.retention)) {
        record.retention = { ...next, updatedAt: this.clock() }
        await this._commit(catalog)
      }
      return publicMetadata(record)
    })
  }

  /** @param {Partial<ArtifactIdentity & {pinned?: boolean}>} [input] */
  async pin({ actor, id, pinned = true } = {}) {
    if (typeof pinned !== 'boolean') invalid('产物固定状态无效。')
    return this._locked(async catalog => {
      const record = this._authorized(catalog, id, actor)
      if (record.retention.pinned !== pinned) {
        record.retention.pinned = pinned
        record.retention.updatedAt = this.clock()
        await this._commit(catalog)
      }
      return publicMetadata(record)
    })
  }

  _deletable(record) {
    const state = record.retention
    return !state.active && state.resolved && !state.pinned && state.references.length === 0
  }

  async _remove(catalog, record) {
    const handle = await this._verifiedHandle(record)
    await handle.close()
    // Catalog first: a crash leaks an unreferenced, quota-counted blob instead
    // of publishing a reference to deleted evidence. Orphans need local repair.
    delete catalog.records[record.id]
    await this._commit(catalog)
    await unlink(path.join(this.objects, `${record.id}.bin`))
    this.verifiedSnapshots.delete(record.id)
    await syncDirectory(this.objects)
  }

  /** @param {Partial<ArtifactIdentity>} [input] */
  async delete({ actor, id } = {}) {
    return this._locked(async catalog => {
      const record = this._authorized(catalog, id, actor)
      if (!this._deletable(record)) fail('artifact_retained', '产物仍被任务使用、尚未确认结果、被引用或已固定，不能删除。', 409)
      await this._remove(catalog, record)
      return { id, deleted: true }
    })
  }

  /** @param {{actor?: ArtifactActor}} [input] */
  async prune({ actor } = {}) {
    const scope = scopeOf(actor)
    return this._locked(async catalog => {
      const removed = []
      for (const record of Object.values(catalog.records)) {
        if (sameScope(record.scope, scope) && this._deletable(record) && this.clock() - record.retention.updatedAt >= this.limits.retentionMs) {
          await this._remove(catalog, record)
          removed.push(record.id)
        }
      }
      return { removed }
    })
  }

  /** Trusted host reconciliation, never an RPC payload. Repeating an identical
   * reconciliation must not restart TTL and make evidence immortal.
   * @param {{actor: ArtifactActor, active: boolean, resolved: boolean, references?: Record<string,string[]>, retired?: boolean}} input */
  async reconcileRetention({ actor, active, resolved, references: retained = {}, retired = false }) {
    const scope = scopeOf(actor)
    if ([active, resolved, retired].some(value => typeof value !== 'boolean') || !retained || typeof retained !== 'object' || Array.isArray(retained)) invalid('产物生命周期参数无效。')
    for (const [id, refs] of Object.entries(retained)) {
      checkedId(id)
      if (!Array.isArray(refs) || refs.length > 1000 || refs.some(value => typeof value !== 'string' || !OPAQUE.test(value))) invalid('产物引用无效。')
    }
    return this._locked(async catalog => {
      let changed = 0, matched = 0
      for (const record of Object.values(catalog.records)) {
        if (!sameScope(record.scope, scope)) continue
        matched++
        const next = { ...record.retention, active, resolved, retired, references: [...new Set(retained[record.id] || [])].sort() }
        if (JSON.stringify(next) !== JSON.stringify(record.retention)) {
          record.retention = { ...next, updatedAt: this.clock() }
          changed++
        }
      }
      if (changed) await this._commit(catalog)
      return { matched, changed }
    })
  }

  /** Actual device-owner host only. Never infer retirement from missing files.
   * @param {{accountId: string, protectedSessions?: string[]}} input */
  async pruneRetired({ accountId, protectedSessions = [] }) {
    if (typeof accountId !== 'string' || !OPAQUE.test(accountId)) invalid('产物账号范围无效。')
    if (!Array.isArray(protectedSessions) || protectedSessions.some(id => typeof id !== 'string' || !OPAQUE.test(id))) invalid('产物会话保护范围无效。')
    const protectedIds = new Set(protectedSessions)
    return this._locked(async catalog => {
      const removed = []
      for (const record of Object.values(catalog.records)) {
        if (record.scope.accountId === accountId && !protectedIds.has(record.scope.sessionId) && record.retention.retired === true && this._deletable(record)
          && this.clock() - record.retention.updatedAt >= this.limits.retentionMs) {
          await this._remove(catalog, record)
          removed.push(record.id)
        }
      }
      return { removed }
    })
  }

  async _fileDigest(file) {
    const handle = await safeOpen(file)
    try {
      const initial = await handle.stat()
      if (initial.size > this.limits.fileBytes) fail('artifact_inspection_limit', '文件超过当前产物单文件上限，请在本机检查。', 409)
      const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024)
      let offset = 0
      while (offset < initial.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, initial.size - offset), offset)
        if (!bytesRead) corrupt()
        hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead
      }
      const final = await handle.stat()
      if (initial.size !== final.size || initial.mtimeMs !== final.mtimeMs || initial.ctimeMs !== final.ctimeMs) corrupt()
      return { sha256: hash.digest('hex'), size: initial.size }
    } finally { await handle.close() }
  }

  async _inspectStorageLocked() {
    const issues = [], inventory = []
    let catalog = null, catalogDigest = 'missing', totalBytes = 0, quarantinedBytes = 0
    const issue = value => {
      const id = `issue_${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
      issues.push({ ...value, id })
    }
    try {
      const raw = await safeRead(this.catalogFile, MAX_CATALOG_BYTES)
      catalogDigest = createHash('sha256').update(raw).digest('hex')
      catalog = await this._catalog()
    } catch (error) {
      if (error.code !== 'ENOENT') issue({ kind: 'catalog_invalid', repairable: false })
    }
    const found = new Set(), recoveryFiles = new Map(), recoveries = []
    for (const [area, directory] of [['objects', this.objects], ['pending', this.temporary], ['quarantine', this.quarantine]]) {
      let names
      try { privateStat(await lstat(directory), true); names = await readdir(directory) } catch (error) {
        if (error.code === 'ENOENT' && area === 'quarantine') continue
        issue({ kind: 'unsafe_directory', area, repairable: false }); continue
      }
      for (const name of names.sort()) {
        const file = path.join(directory, name)
        let info, digest
        try {
          info = await lstat(file); privateStat(info)
          digest = await this._fileDigest(file)
          inventory.push({ area, name, ...digest, ino: String(info.ino), dev: String(info.dev), ctimeMs: info.ctimeMs, mode: info.mode })
          totalBytes += info.size
          if (area === 'quarantine') { quarantinedBytes += info.size; recoveryFiles.set(name, digest); continue }
        } catch (error) {
          inventory.push({ area, name, unsafe: true, size: info?.size, ino: String(info?.ino), ctimeMs: info?.ctimeMs })
          issue({ kind: error.code === 'artifact_inspection_limit' ? 'oversized_entry' : 'unsafe_entry', area, name, repairable: false }); continue
        }
        const artifactId = area === 'objects' ? name.replace(/\.bin$/, '') : null
        const record = artifactId && catalog?.records[artifactId]
        if (record) {
          found.add(artifactId)
          if (record.sha256 !== digest.sha256 || record.size !== digest.size) issue({ kind: 'content_mismatch', artifactId, area, name, repairable: false })
        } else if (catalog) {
          const expectedName = area === 'pending' ? /^[0-9a-f-]{36}\.part$/ : /^art_[0-9a-f-]{36}\.bin$/
          issue({ kind: expectedName.test(name) ? area === 'pending' ? 'orphan_pending' : 'orphan_object' : 'unexpected_entry', area, name, ...digest, repairable: expectedName.test(name) })
        }
      }
    }
    for (const [name] of recoveryFiles) {
      if (!/^recovery_[0-9a-f-]{36}\.(json|blob)$/.test(name)) { issue({ kind: 'quarantine_invalid', repairable: false }); continue }
      if (!name.endsWith('.json')) {
        if (!recoveryFiles.has(name.replace(/\.blob$/, '.json'))) issue({ kind: 'quarantine_manifest_missing', repairable: false })
        continue
      }
      try {
        const receipt = JSON.parse(await safeRead(path.join(this.quarantine, name), 16384))
        const payload = recoveryFiles.get(name.replace(/\.json$/, '.blob'))
        if (receipt.schemaVersion !== 1 || `${receipt.recoveryId}.json` !== name || !['prepared', 'quarantined', 'restored'].includes(receipt.state)) throw new Error()
        recoveries.push({ recoveryId: receipt.recoveryId, state: receipt.state, size: receipt.size,
          restorable: ['prepared', 'quarantined'].includes(receipt.state) && payload?.sha256 === receipt.sha256 && payload?.size === receipt.size })
        if (receipt.state === 'restored') { if (payload) throw new Error() }
        else if (!payload || payload.sha256 !== receipt.sha256 || payload.size !== receipt.size || receipt.state === 'prepared') {
          issue({ kind: receipt.state === 'prepared' ? 'quarantine_incomplete' : 'quarantine_content_mismatch', repairable: false })
        }
      } catch { issue({ kind: 'quarantine_invalid', repairable: false }) }
    }
    if (!catalog && (inventory.length || issues.length)) issue({ kind: 'catalog_recovery_required', repairable: false })
    if (catalog) for (const id of Object.keys(catalog.records)) if (!found.has(id)) issue({ kind: 'payload_unavailable', artifactId: id, repairable: false })
    const checkToken = createHash('sha256').update(JSON.stringify({ catalogDigest, inventory })).digest('hex')
    const publicIssues = issues.map(({ area: _area, name: _name, ...item }) => item)
    return { issues, report: { schemaVersion: 1, checkToken, healthy: !issues.length,
      indexed: Object.keys(catalog?.records || {}).length, totalBytes, quarantinedBytes, issues: publicIssues, recoveries } }
  }

  /** Local trusted-host maintenance ONLY: inspect does not infer lost metadata
   * or delete broken evidence. It intentionally has no remote protocol method. */
  async inspectStorage() {
    return this._locked(async () => (await this._inspectStorageLocked()).report, null, false)
  }

  /** Explicit, snapshot-bound and reversible isolation of UNINDEXED files.
   * Corrupt indexes and indexed missing/tampered content need a real backup;
   * never manufacture provenance by adopting arbitrary files into the catalog.
   * @param {{checkToken: string, issueIds: string[], confirmed: boolean}} input */
  async quarantineOrphans({ checkToken, issueIds, confirmed }) {
    if (confirmed !== true) fail('artifact_confirmation_required', '请明确确认隔离所选孤立文件；不会删除文件，也不会推定未决操作已经完成。', 409)
    if (typeof checkToken !== 'string' || !HASH.test(checkToken) || !Array.isArray(issueIds) || !issueIds.length || issueIds.length > 100 || new Set(issueIds).size !== issueIds.length) invalid('产物修复参数无效。')
    return this._locked(async () => {
      const inspection = await this._inspectStorageLocked()
      if (inspection.report.checkToken !== checkToken) fail('artifact_inspection_stale', '产物目录已改变，请重新检查后确认修复。', 409)
      const selected = issueIds.map(id => inspection.issues.find(item => item.id === id))
      if (selected.some(item => !item?.repairable || !['orphan_pending', 'orphan_object'].includes(item.kind))) fail('artifact_repair_refused', '所选问题不能安全自动修复。请使用可信备份恢复索引或内容，不会删除或猜测原数据。', 409)
      await ensureDirectory(this.quarantine)
      const quarantined = []
      for (const item of selected) {
        const recoveryId = `recovery_${randomUUID()}`
        const file = path.join(item.area === 'objects' ? this.objects : this.temporary, item.name)
        const destination = path.join(this.quarantine, `${recoveryId}.blob`)
        const manifest = path.join(this.quarantine, `${recoveryId}.json`)
        const receipt = { schemaVersion: 1, recoveryId, issueId: item.id, source: { area: item.area, name: item.name },
          sha256: item.sha256, size: item.size, createdAt: this.clock(), state: 'prepared' }
        await publishJson(manifest, receipt)
        await rename(file, destination)
        await syncDirectory(path.dirname(file)); await syncDirectory(this.quarantine)
        await publishJson(manifest, { ...receipt, state: 'quarantined' })
        quarantined.push({ recoveryId, size: item.size })
      }
      return { quarantined, recoverable: true, note: '文件已隔离而未删除，仍计入容量。可凭 recoveryId 在本机恢复；未改变任何操作结果或任务权限。' }
    }, null, false)
  }

  /** Restore an explicitly quarantined orphan without overwriting anything.
   * @param {{recoveryId: string, confirmed: boolean}} input */
  async restoreQuarantined({ recoveryId, confirmed }) {
    if (confirmed !== true) fail('artifact_confirmation_required', '请确认将隔离文件恢复到原产物目录；不会覆盖现有文件。', 409)
    if (typeof recoveryId !== 'string' || !/^recovery_[0-9a-f-]{36}$/.test(recoveryId)) invalid('恢复标识无效。')
    return this._locked(async () => {
      await ensureDirectory(this.quarantine)
      const manifest = path.join(this.quarantine, `${recoveryId}.json`)
      let receipt
      try { receipt = JSON.parse(await safeRead(manifest, 16384)) } catch { fail('artifact_recovery_invalid', '隔离恢复记录缺失或损坏，请在本机检查。', 409) }
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) fail('artifact_recovery_invalid', '隔离恢复记录无效，不会移动文件。', 409)
      const validName = receipt.source?.area === 'objects' ? /^art_[0-9a-f-]{36}\.bin$/ : /^[0-9a-f-]{36}\.part$/
      if (receipt.schemaVersion !== 1 || receipt.recoveryId !== recoveryId || !['prepared', 'quarantined'].includes(receipt.state)
        || !['objects', 'pending'].includes(receipt.source?.area) || !validName.test(receipt.source?.name || '') || !HASH.test(receipt.sha256)) fail('artifact_recovery_invalid', '隔离恢复记录无效，不会移动文件。', 409)
      const source = path.join(this.quarantine, `${recoveryId}.blob`)
      const digest = await this._fileDigest(source)
      if (digest.sha256 !== receipt.sha256 || digest.size !== receipt.size) corrupt()
      const target = path.join(receipt.source.area === 'objects' ? this.objects : this.temporary, receipt.source.name)
      // link() is no-replace, unlike rename(); never overwrite a newly-created
      // destination between an existence check and the write.
      await link(source, target)
      await unlink(source)
      await syncDirectory(path.dirname(target)); await syncDirectory(this.quarantine)
      await publishJson(manifest, { ...receipt, state: 'restored', restoredAt: this.clock() })
      return { recoveryId, restored: true }
    }, null, false)
  }

  /** Trusted local API only. Caller owns and MUST close the verified handle.
   * @param {Partial<ArtifactIdentity>} [input] */
  async openDownload({ actor, id } = {}) {
    return this._locked(async catalog => {
      const record = this._authorized(catalog, id, actor)
      return { metadata: publicMetadata(record), handle: await this._verifiedHandle(record) }
    })
  }
}

export function createArtifactStore(options) { return new ArtifactStore(options) }
