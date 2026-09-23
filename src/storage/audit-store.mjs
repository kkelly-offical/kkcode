import { createHash, randomUUID } from "node:crypto"
import { appendFile, open, readFile, rename, stat, unlink, mkdir, rmdir, link, writeFile } from "node:fs/promises"
import os from 'node:os'
import { redactSensitive } from "../http/identity.mjs"
import { ensureUserRoot, auditLogPath, auditStorePath } from "./paths.mjs"
import { readJson } from "./json-store.mjs"

export const AUDIT_SCHEMA = "kk.audit.v1"

const DEFAULTS = Object.freeze({
  maxEntries: 5000,
  maxBytes: 10 * 1024 * 1024,
  maxFiles: 5
})
const AUDIT_LOCK_TIMEOUT_MS = 10_000
const AUDIT_CONTENT_KEYS = /^(?:args|body|command|content|messages?|new_string|old_string|output|prompt|response|system|tool_args)$/i

const state = { ...DEFAULTS }
let writeLock = Promise.resolve()

function legacyDefaults() {
  return {
    updatedAt: Date.now(),
    entries: []
  }
}

export function configureAuditStore(options = {}) {
  if (options.reset === true) Object.assign(state, DEFAULTS)
  if (Number.isInteger(options.maxEntries) && options.maxEntries > 100) {
    state.maxEntries = options.maxEntries
  }
  if (Number.isInteger(options.maxBytes) && options.maxBytes >= 256) {
    state.maxBytes = options.maxBytes
  }
  if (Number.isInteger(options.maxFiles) && options.maxFiles >= 1) {
    state.maxFiles = options.maxFiles
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
  )
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(value))
}

function summarizeContent(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value ?? null)
  return {
    length: Buffer.byteLength(serialized, "utf8"),
    sha256: createHash("sha256").update(serialized).digest("hex")
  }
}

function isContentSummary(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Number.isInteger(value.length) &&
    /^[a-f0-9]{64}$/.test(String(value.sha256 || ""))
  )
}

function isContentValue(value) {
  return typeof value === "string" || Boolean(value && typeof value === "object")
}

function sanitizeAuditValue(value, seen = new WeakSet()) {
  const redacted = redactSensitive(value)
  if (!redacted || typeof redacted !== "object") return redacted
  if (seen.has(redacted)) return "[CIRCULAR]"
  seen.add(redacted)
  if (Array.isArray(redacted)) {
    const output = redacted.map((item) => sanitizeAuditValue(item, seen))
    seen.delete(redacted)
    return output
  }
  const output = {}
  for (const [key, item] of Object.entries(redacted)) {
    output[key] = AUDIT_CONTENT_KEYS.test(key) && isContentValue(item) && !isContentSummary(item)
      ? summarizeContent(item)
      : sanitizeAuditValue(item, seen)
  }
  seen.delete(redacted)
  return output
}

function hashEvent(entry) {
  const unsigned = { ...entry }
  delete unsigned.eventHash
  return createHash("sha256")
    .update(`${entry.previousHash || ""}\n${canonicalJson(unsigned)}`)
    .digest("hex")
}

function rotatedPath(index) {
  return `${auditLogPath()}.${index}`
}

/** 「锁被别人持有」的错误码集合。EEXIST 是 POSIX，其余三个是 Windows 的表现。 */
const LOCK_CONTENTION_CODES = new Set(["EEXIST", "EPERM", "EBUSY", "EACCES"])

function auditLockPath() {
  return `${auditLogPath()}.lock`
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Only ESRCH proves death; permission/OS errors must fail closed.
    return error?.code !== "ESRCH"
  }
}

function validAuditOwner(owner) {
  return owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && owner.pid <= 2147483647 && typeof owner.token === 'string' && owner.token.length > 0 && owner.token.length <= 128
}

async function removeStaleAuditLock(file) {
  const recovery = `${file}.recovery`
  try { await mkdir(recovery, { mode: 0o700 }) }
  catch (error) { if (LOCK_CONTENTION_CODES.has(error?.code)) return false; throw error }
  try {
    const metadata = await readFile(file, "utf8").then(JSON.parse)
    // Legacy audit locks have no host field. Malformed/foreign metadata is not
    // proof of death; never evict an initializing or paused live writer by age.
    if (!validAuditOwner(metadata) || metadata.host && metadata.host !== os.hostname() || processIsAlive(metadata.pid)) return false
    // Serialize recovery actors and re-read identity under the recovery guard.
    // A stale snapshot must not authorize unlinking a newly acquired live lock.
    const current = await readFile(file, 'utf8').then(JSON.parse)
    if (!validAuditOwner(current) || current.token !== metadata.token || current.pid !== metadata.pid || current.host && current.host !== os.hostname() || processIsAlive(current.pid)) return false
    await unlink(file)
    return true
  } catch (error) {
    return error?.code === 'ENOENT'
  } finally { await rmdir(recovery).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}

async function acquireAuditLock() {
  const file = auditLockPath()
  const token = randomUUID()
  const deadline = Date.now() + AUDIT_LOCK_TIMEOUT_MS
  const candidate = `${file}.${process.pid}.${token}.candidate`
  // Publish fully written metadata atomically. An empty lock can otherwise be
  // mistaken for an abandoned file while its owner is paused before writing.
  await writeFile(candidate, JSON.stringify({ token, pid: process.pid, host: os.hostname(), createdAt: Date.now() }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  try {
    while (Date.now() <= deadline) {
      try { await link(candidate, file); return { file, token } }
      catch (error) {
        if (!LOCK_CONTENTION_CODES.has(error?.code)) throw error
        if (await removeStaleAuditLock(file)) continue
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    throw new Error("audit log lock timed out; inspect the owner/recovery marker before retrying")
  } finally { await unlink(candidate).catch(() => {}) }
}

async function releaseAuditLock(lock) {
  if (!lock?.file) return
  try {
    const metadata = JSON.parse(await readFile(lock.file, "utf8"))
    if (metadata?.token === lock.token) await unlink(lock.file)
  } catch {
    // The lock was already removed or replaced by a stale-lock recovery.
  }
}

async function withAuditLock(run) {
  const lock = await acquireAuditLock()
  try {
    return await run()
  } finally {
    await releaseAuditLock(lock)
  }
}

async function exists(file) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

async function orderedAuditFiles() {
  const files = []
  for (let index = state.maxFiles - 1; index >= 1; index--) {
    const file = rotatedPath(index)
    if (await exists(file)) files.push(file)
  }
  if (await exists(auditLogPath())) files.push(auditLogPath())
  return files
}

function parseJsonLines(content, file, { tolerateInvalid = true } = {}) {
  const entries = []
  const errors = []
  const lines = content.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()
    if (!line) continue
    try {
      entries.push(JSON.parse(line))
    } catch (error) {
      errors.push({ file, line: index + 1, error: error.message })
      if (!tolerateInvalid) break
    }
  }
  return { entries, errors }
}

async function readChainedEntries({ tolerateInvalid = true } = {}) {
  const entries = []
  const errors = []
  for (const file of await orderedAuditFiles()) {
    const content = await readFile(file, "utf8").catch(() => "")
    const parsed = parseJsonLines(content, file, { tolerateInvalid })
    entries.push(...parsed.entries)
    errors.push(...parsed.errors)
  }
  return { entries, errors }
}

async function lastChainedEntry() {
  const candidates = [auditLogPath()]
  for (let index = 1; index < state.maxFiles; index++) candidates.push(rotatedPath(index))

  for (const file of candidates) {
    let handle
    try {
      handle = await open(file, "r")
      const { size } = await handle.stat()
      let end = size
      const chunks = []
      while (end > 0) {
        const start = Math.max(0, end - 64 * 1024)
        const buffer = Buffer.alloc(end - start)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
        if (bytesRead !== buffer.length) throw new Error('Audit tail changed while reading; refusing an unverified append')
        chunks.unshift(buffer)
        const combined = Buffer.concat(chunks)
        let contentEnd = combined.length
        while (contentEnd > 0 && [0x0a, 0x0d, 0x20, 0x09].includes(combined[contentEnd - 1])) contentEnd--
        const newline = combined.lastIndexOf(0x0a, contentEnd - 1)
        if (newline >= 0 || start === 0) {
          const line = combined.subarray(newline + 1, contentEnd).toString("utf8")
          if (line) return JSON.parse(line)
          break
        }
        end = start
      }
    } catch (error) {
      // Only absence permits falling back to a rotated file. Treating a short,
      // malformed or unreadable tail as "no head" silently forks the hash chain.
      if (error?.code !== 'ENOENT') throw error
    } finally {
      await handle?.close().catch(() => {})
    }
  }
  return null
}

async function rotateIfNeeded(nextLineBytes) {
  const current = auditLogPath()
  const currentSize = await stat(current).then((value) => value.size).catch(() => 0)
  if (!currentSize || currentSize + nextLineBytes <= state.maxBytes) return

  const oldest = rotatedPath(state.maxFiles - 1)
  if (state.maxFiles > 1) await unlink(oldest).catch(() => {})
  for (let index = state.maxFiles - 2; index >= 1; index--) {
    await rename(rotatedPath(index), rotatedPath(index + 1)).catch((error) => {
      if (error?.code !== "ENOENT") throw error
    })
  }
  if (state.maxFiles > 1) {
    await rename(current, rotatedPath(1))
  } else {
    await unlink(current).catch(() => {})
  }
}

function normalizeEntry(entry, previousHash) {
  const createdAt = Number(entry.createdAt || Date.now())
  const sanitized = sanitizeAuditValue(entry)
  const eventId = String(sanitized.eventId || sanitized.id || `aud_${randomUUID()}`)
  const normalized = {
    schema: AUDIT_SCHEMA,
    eventId,
    id: eventId,
    createdAt,
    timestamp: sanitized.timestamp || new Date(createdAt).toISOString(),
    traceId: sanitized.traceId || null,
    requestId: sanitized.requestId || null,
    parentEventId: sanitized.parentEventId || null,
    ...sanitized,
    previousHash: previousHash || null
  }
  normalized.eventHash = hashEvent(normalized)
  return normalized
}

export async function readAuditStore() {
  await ensureUserRoot()
  const legacy = await readJson(auditStorePath(), legacyDefaults())
  const { entries: chained } = await readChainedEntries()
  const legacyEntries = Array.isArray(legacy.entries)
    ? legacy.entries.map((entry) => sanitizeAuditValue(entry))
    : []
  const entries = [...legacyEntries, ...chained]
    .slice(-state.maxEntries)
  return {
    updatedAt: entries.at(-1)?.createdAt || legacy.updatedAt || Date.now(),
    entries
  }
}

export async function appendAuditEntry(entry) {
  const run = async () => {
    await ensureUserRoot()
    return withAuditLock(async () => {
      const previous = await lastChainedEntry()
      const normalized = normalizeEntry(entry, previous?.eventHash || null)
      const line = `${JSON.stringify(normalized)}\n`
      await rotateIfNeeded(Buffer.byteLength(line, "utf8"))
      await appendFile(auditLogPath(), line, { encoding: "utf8", mode: 0o600 })
      return normalized
    })
  }
  const result = writeLock.then(run, run)
  writeLock = result.then(() => undefined, () => undefined)
  return result
}

export async function safeAppendAuditEntry(entry) {
  try {
    return await appendAuditEntry(entry)
  } catch {
    return null
  }
}

function entryStatus(entry) {
  return entry.status || (entry.ok === false ? "error" : entry.ok === true ? "ok" : null)
}

export async function listAuditEntries(options = {}) {
  const store = await readAuditStore()
  const query = typeof options === "number" ? { limit: options } : options
  const limit = Math.max(1, Number(query.limit || 200))

  const list = store.entries.filter((entry) => {
    if (query.sessionId && entry.sessionId !== query.sessionId) return false
    if (query.tool && entry.tool !== query.tool) return false
    if (query.type && entry.type !== query.type) return false
    if (query.traceId && entry.traceId !== query.traceId) return false
    if (query.provider && entry.provider !== query.provider) return false
    if (query.reviewId && entry.reviewId !== query.reviewId) return false
    if (query.status && entryStatus(entry) !== query.status) return false
    if (query.sinceMs && entry.createdAt < query.sinceMs) return false
    return true
  })

  return list.slice(-limit).reverse()
}

export async function verifyAuditChain() {
  await ensureUserRoot()
  const legacy = await readJson(auditStorePath(), legacyDefaults())
  const parsed = await withAuditLock(() => readChainedEntries({ tolerateInvalid: false }))
  const errors = [...parsed.errors]
  let previous = null

  for (let index = 0; index < parsed.entries.length; index++) {
    const entry = parsed.entries[index]
    if (entry.schema !== AUDIT_SCHEMA) {
      errors.push({ index, eventId: entry.eventId || entry.id, error: "unsupported schema" })
    }
    if (index > 0 && entry.previousHash !== previous?.eventHash) {
      errors.push({ index, eventId: entry.eventId || entry.id, error: "previous hash mismatch" })
    }
    if (hashEvent(entry) !== entry.eventHash) {
      errors.push({ index, eventId: entry.eventId || entry.id, error: "event hash mismatch" })
    }
    previous = entry
  }

  return {
    ok: errors.length === 0,
    schema: AUDIT_SCHEMA,
    entries: parsed.entries.length,
    legacyEntries: Array.isArray(legacy.entries) ? legacy.entries.length : 0,
    anchorHash: parsed.entries[0]?.previousHash || null,
    headHash: previous?.eventHash || null,
    errors
  }
}

/** @param {{ format?: string } & Record<string, any>} [options] */
export async function exportAuditEntries({ format = "json", ...filters } = {}) {
  const entries = (await listAuditEntries({ ...filters, limit: filters.limit || state.maxEntries })).reverse()
  if (format === "jsonl") return entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : "")
  if (format === "json") return `${JSON.stringify(entries, null, 2)}\n`
  throw new Error(`unsupported audit export format: ${format}`)
}

export async function auditStats() {
  const store = await readAuditStore()
  const now = Date.now()
  const oneHour = now - 60 * 60 * 1000
  const oneDay = now - 24 * 60 * 60 * 1000

  let error1h = 0
  let error24h = 0
  for (const entry of store.entries) {
    const isError = String(entry.type || "").includes("error") || entry.ok === false
    if (!isError) continue
    if (entry.createdAt >= oneHour) error1h += 1
    if (entry.createdAt >= oneDay) error24h += 1
  }

  return {
    total: store.entries.length,
    error1h,
    error24h,
    maxEntries: state.maxEntries
  }
}
