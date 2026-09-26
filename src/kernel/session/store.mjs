import { randomUUID } from "node:crypto"
import path from "node:path"
import { access, readdir, unlink, rm, readFile, mkdir } from "node:fs/promises"
import {
  sessionShardRootPath
} from "../../storage/paths.mjs"
import { readJson } from "../../storage/json-store.mjs"
import { writePrivateFile } from '../../storage/private-file.mjs'
import { acquireProcessLock } from '../../storage/process-lock.mjs'

function now() {
  return Date.now()
}

function defaultIndex() {
  return {
    version: 2,
    updatedAt: now(),
    sessions: {}
  }
}

function defaultSessionData() {
  return {
    messages: [],
    parts: []
  }
}

function newMessage(role, content, extra = {}) {
  return {
    id: `msg_${randomUUID().slice(0, 12)}`,
    role,
    content,
    createdAt: now(),
    ...extra
  }
}

function newPart(type, payload = {}) {
  return {
    id: `part_${randomUUID().slice(0, 12)}`,
    type,
    createdAt: now(),
    ...payload
  }
}

function normalizeSessionData(raw) {
  if (!raw || typeof raw !== "object") return defaultSessionData()
  return {
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    parts: Array.isArray(raw.parts) ? raw.parts : []
  }
}

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

const storeOptions = { sessionShardEnabled: true, flushIntervalMs: 1000 }
const rootStates = new Map()
let state
const newState = root => ({
  root,
  loaded: false,
  index: defaultIndex(),
  sessionCache: new Map(),
  indexOperations: [],
  dataOperations: new Map(),
  dirtyIndex: false,
  dirtySessions: new Set(),
  flushTimer: null,
  flushGeneration: 0,
  options: storeOptions
})
const sessionIndexPath = () => path.join(state.root, 'index.json')
const sessionDataPath = id => {
  const match = typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.exec(id)
  if (!match || ['__proto__', 'constructor', 'prototype'].includes(match[0])) throw Object.assign(new Error('Invalid session id'), { code: 'invalid_session' })
  return path.join(state.root, `${match[0]}.json`)
}
const legacySessionStorePath = () => path.join(path.dirname(state.root), 'session-store.json')
const sessionCheckpointRootPath = () => path.join(path.dirname(state.root), 'checkpoints')
const writeJson = (file, value) => writePrivateFile(file, JSON.stringify(value, null, 2) + '\n')
async function readStrict(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
}
async function readSessionData(sessionId) {
  const data = await readStrict(sessionDataPath(sessionId), defaultSessionData())
  if (!data || !Array.isArray(data.messages) || !Array.isArray(data.parts)) throw new Error('Invalid session data; inspect or restore the shard before writing')
  return data
}

function applyIndexOperation(index, operation) {
  const { sessionId, kind, value } = operation, existing = index.sessions[sessionId]
  if (kind === 'touch') {
    index.sessions[sessionId] = {
      ...existing, id: sessionId,
      ...Object.fromEntries(['mode', 'model', 'providerType', 'cwd'].filter(key => value[key] !== undefined).map(key => [key, value[key]])),
      title: existing?.title || value.title || `${value.mode}:${value.model}`,
      status: value.status,
      parentSessionId: value.parentSessionId || existing?.parentSessionId || null,
      forkFrom: value.forkFrom || existing?.forkFrom || null,
      retryMeta: existing?.retryMeta || null, patchRefs: existing?.patchRefs || [],
      reviewDecisions: existing?.reviewDecisions || [], budgetState: existing?.budgetState || null,
      createdAt: existing?.createdAt || value.updatedAt, updatedAt: Math.max(existing?.updatedAt || 0, value.updatedAt)
    }
  } else if (kind === 'patch' && existing) index.sessions[sessionId] = { ...existing, ...value, updatedAt: Math.max(existing.updatedAt || 0, value.updatedAt || 0) }
  else if (kind === 'review' && existing) {
    const decisions = existing.reviewDecisions || []
    if (!decisions.some(item => item.id === value.id)) index.sessions[sessionId] = { ...existing, reviewDecisions: [...decisions, value], updatedAt: Math.max(existing.updatedAt || 0, value.createdAt) }
  } else if (kind === 'fork') {
    if (existing) throw Object.assign(new Error('Fork target session already exists'), { code: 'session_conflict' })
    index.sessions[sessionId] = value
  } else if (kind === 'delete') delete index.sessions[sessionId]
}

function queueIndexOperation(sessionId, kind, value) {
  sessionDataPath(sessionId)
  const operation = { sessionId, kind, value: structuredClone(value) }
  applyIndexOperation(state.index, operation)
  state.indexOperations.push(operation)
  markDirty()
}
function applyDataOperations(data, operations) {
  for (const { kind, value, baseline } of operations) {
    if (kind === 'message' && !data.messages.some(message => message.id === value.id)) data.messages.push(value)
    if (kind === 'part' && !data.parts.some(part => part.id === value.id)) data.parts.push(value)
    if (kind === 'replace') {
      const replaced = new Set(baseline), inserted = new Set(value.map(message => message.id))
      // Rewind/compaction removes only messages it actually observed. A later
      // append from another process must not disappear with an old snapshot.
      data.messages = [...value, ...data.messages.filter(message => !replaced.has(message.id) && !inserted.has(message.id))]
    }
    if (kind === 'fork') { data.messages = value.messages; data.parts = value.parts }
  }
  return data
}
function queueDataOperation(sessionId, operation) {
  sessionDataPath(sessionId)
  const operations = state.dataOperations.get(sessionId) || []
  operations.push(structuredClone(operation)); state.dataOperations.set(sessionId, operations)
  state.sessionCache.delete(sessionId); markDirty(sessionId)
}

const LOCK_TIMEOUT_MS = 30000

let lock = Promise.resolve()
function withLock(fn, root = path.resolve(sessionShardRootPath()), shouldRun = () => true) {
  const runTransaction = async () => {
    // A timer may have queued behind an explicit flush. Check its generation
    // before acquiring the process lock, which itself creates files/directories.
    if (!shouldRun()) return
    if (!rootStates.has(root)) rootStates.set(root, newState(root))
    state = rootStates.get(root)
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    let lease
    for (;;) {
      try { lease = await acquireProcessLock(path.join(root, '.store.lock')); break }
      catch (error) {
        if (error.code !== 'device_in_use') throw error
        if (Date.now() >= deadline) throw Object.assign(new Error('Session store is busy in another process'), { code: 'session_store_busy' })
        await new Promise(resolve => setTimeout(resolve, 10 + Math.floor(Math.random() * 20)))
      }
    }
    state.sessionCache.clear()
    try { return await fn() } finally { await lease.release() }
  }
  const run = lock.then(runTransaction, runTransaction)
  lock = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

function scheduleFlush() {
  if (state.options.flushIntervalMs <= 0) return
  if (state.flushTimer) return
  const scheduledState = state
  const generation = ++scheduledState.flushGeneration
  state.flushTimer = setTimeout(() => {
    if (scheduledState.flushGeneration !== generation) return
    scheduledState.flushTimer = null
    withLock(() => flushUnsafe(), scheduledState.root, () => scheduledState.flushGeneration === generation
      && (scheduledState.dirtyIndex || scheduledState.dirtySessions.size > 0)).catch((err) => {
      console.error("[store] flush failed:", err?.message || err)
    })
  }, state.options.flushIntervalMs)
}

function markDirty(sessionId = null) {
  state.dirtyIndex = true
  if (sessionId) state.dirtySessions.add(sessionId)
  if (state.options.flushIntervalMs <= 0) return
  scheduleFlush()
}

async function flushUnsafe() {
  state.flushGeneration++
  if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null }
  if (!state.loaded) return
  if (!state.dirtyIndex && !state.dirtySessions.size) return
  await mkdir(state.root, { recursive: true, mode: 0o700 })
  // Validate metadata conflicts before touching any shard. A duplicate fork
  // target must never overwrite its data and only then discover the conflict.
  const current = state.dirtyIndex ? await readStrict(sessionIndexPath(), defaultIndex()) : null
  if (current) for (const operation of state.indexOperations) applyIndexOperation(current, operation)

  for (const sessionId of [...state.dirtySessions]) {
    const data = applyDataOperations(await readSessionData(sessionId), state.dataOperations.get(sessionId) || [])
    await writeJson(sessionDataPath(sessionId), data)
    if (current?.sessions[sessionId]) current.sessions[sessionId].hasContent = data.messages.length > 0 || data.parts.length > 0
    state.sessionCache.set(sessionId, data)
    state.dataOperations.delete(sessionId)
    state.dirtySessions.delete(sessionId)
  }

  if (state.dirtyIndex) {
    current.updatedAt = now()
    await writeJson(sessionIndexPath(), current)
    state.index = current; state.indexOperations = []
    state.dirtyIndex = false
  }
  if (!state.dirtyIndex && !state.dirtySessions.size && state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null }
}

export async function flushNow() {
  return withLock(async () => {
    await flushUnsafe()
  })
}

async function loadSessionDataUnsafe(sessionId) {
  if (state.sessionCache.has(sessionId)) {
    return state.sessionCache.get(sessionId)
  }
  const data = applyDataOperations(await readSessionData(sessionId), state.dataOperations.get(sessionId) || [])
  state.sessionCache.set(sessionId, data)
  return data
}

async function migrateLegacyStoreIfNeededUnsafe() {
  const indexFile = sessionIndexPath()
  if (await exists(indexFile)) {
    state.index = await readStrict(indexFile, defaultIndex())
    return
  }

  const legacy = await readStrict(legacySessionStorePath(), null)
  if (!legacy || typeof legacy !== "object" || !legacy.sessions || typeof legacy.sessions !== "object") {
    state.index = defaultIndex()
    await writeJson(indexFile, state.index)
    return
  }

  const next = defaultIndex()
  for (const [sessionId, session] of Object.entries(legacy.sessions || {})) {
    next.sessions[sessionId] = {
      ...session
    }
    const data = normalizeSessionData({
      messages: legacy.messages?.[sessionId] || [],
      parts: legacy.parts?.[sessionId] || []
    })
    state.sessionCache.set(sessionId, data)
    await writeJson(sessionDataPath(sessionId), data)
  }
  state.index = next
  await writeJson(indexFile, next)
}

async function ensureLoadedUnsafe() {
  if (!state.loaded) {
    await mkdir(state.root, { recursive: true, mode: 0o700 })
    await migrateLegacyStoreIfNeededUnsafe()
    state.loaded = true
  } else state.index = await readStrict(sessionIndexPath(), defaultIndex())
  if (!state.index || !state.index.sessions || typeof state.index.sessions !== 'object' || Array.isArray(state.index.sessions)) throw new Error('Invalid session index; restore a backup before writing')
  for (const operation of state.indexOperations) applyIndexOperation(state.index, operation)
}

export function configureSessionStore(options = {}) {
  if (typeof options.sessionShardEnabled === "boolean") {
    storeOptions.sessionShardEnabled = options.sessionShardEnabled
  }
  if (Number.isInteger(options.flushIntervalMs) && options.flushIntervalMs >= 0) {
    storeOptions.flushIntervalMs = options.flushIntervalMs
  }
}

export async function touchSession({
  sessionId,
  mode,
  model,
  providerType,
  cwd,
  title = null,
  status = "active",
  parentSessionId = null,
  forkFrom = null
}) {
  return withLock(async () => {
    await ensureLoadedUnsafe()
    queueIndexOperation(sessionId, 'touch', { mode, model, providerType, cwd, title, status, parentSessionId, forkFrom, updatedAt: now() })
    queueDataOperation(sessionId, { kind: 'ensure' })
    if (state.options.flushIntervalMs <= 0) await flushUnsafe()
    return state.index.sessions[sessionId]
  })
}

export async function updateSession(sessionId, patch) {
  return withLock(async () => {
    await ensureLoadedUnsafe()
    const current = state.index.sessions[sessionId]
    if (!current) return null
    if (patch.context === undefined && (patch.model !== undefined && patch.model !== current.model || patch.providerType !== undefined && patch.providerType !== current.providerType)) patch = { ...patch, context: null, promptReport: null }
    queueIndexOperation(sessionId, 'patch', { ...patch, updatedAt: now() })
    if (state.options.flushIntervalMs <= 0) await flushUnsafe()
    return state.index.sessions[sessionId]
  })
}

/** Atomic metadata compare-and-set for asynchronous title generation and manual
 * rename races. Expected fields are never accepted from an unvalidated RPC. */
export async function updateSessionIf(sessionId, expected, patch) {
  return withLock(async () => {
    await ensureLoadedUnsafe(); await flushUnsafe()
    const current = state.index.sessions[sessionId]
    if (!current || Object.entries(expected).some(([key, value]) => current[key] !== value)) return null
    if (patch.context === undefined && (patch.model !== undefined && patch.model !== current.model || patch.providerType !== undefined && patch.providerType !== current.providerType)) patch = { ...patch, context: null, promptReport: null }
    queueIndexOperation(sessionId, 'patch', { ...patch, updatedAt: now() })
    await flushUnsafe()
    return state.index.sessions[sessionId]
  })
}

/** Rewind is a transaction over messages AND their tool/thinking parts. Keep a
 * private recoverable checkpoint and refuse stale snapshots from another host. */
export async function replaceConversationForRewind(sessionId, retained, observed) {
  return withLock(async () => {
    await ensureLoadedUnsafe(); await flushUnsafe()
    const data = await readSessionData(sessionId)
    if (JSON.stringify(data.messages.map(message => message.id)) !== JSON.stringify(observed.map(message => message.id))) throw Object.assign(new Error('Conversation changed; reload it before rewinding'), { code: 'history_changed' })
    const kept = new Set(retained.map(message => message.id)), removed = observed.filter(message => !kept.has(message.id))
    const removedIds = new Set(removed.map(message => message.id)), removedTurns = new Set(removed.map(message => message.turnId).filter(Boolean))
    const cutoff = removed[0]?.createdAt ?? Infinity
    const parts = data.parts.filter(part => {
      if (part.messageId) return !removedIds.has(part.messageId)
      if (part.turnId) return !removedTurns.has(part.turnId)
      return !Number.isFinite(part.createdAt) || part.createdAt < cutoff
    })
    // Reuse the validated shard identity, never a caller-supplied path segment.
    const directory = path.join(sessionCheckpointRootPath(), path.basename(sessionDataPath(sessionId), '.json'))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeJson(path.join(directory, 'before-rewind.json'), { savedAt: now(), session: state.index.sessions[sessionId], ...data })
    const next = { messages: retained, parts }
    await writeJson(sessionDataPath(sessionId), next)
    state.sessionCache.set(sessionId, next)
    queueIndexOperation(sessionId, 'patch', { status: 'idle', historyRevision: randomUUID(), hasContent: retained.length > 0 || parts.length > 0, updatedAt: now() })
    await flushUnsafe()
    return { removedParts: data.parts.length - parts.length, backup: 'before-rewind' }
  })
}

export async function appendMessage(sessionId, role, content, extra = {}) {
  return withLock(async () => {
    await ensureLoadedUnsafe()
    const message = newMessage(role, content, extra)
    queueDataOperation(sessionId, { kind: 'message', value: message })
    if (state.index.sessions[sessionId]) queueIndexOperation(sessionId, 'patch', { updatedAt: now() })
    if (state.options.flushIntervalMs <= 0) await flushUnsafe()
    return message
  })
}

export async function replaceMessages(sessionId, newMessages, options = {}) {
  return withLock(async () => {
    options.signal?.throwIfAborted()
    await ensureLoadedUnsafe()
    // Compaction must compare the snapshot seen BEFORE its asynchronous model
    // call, not capture a fresh baseline after new turns/rewinds have arrived.
    if (options.observedMessages) await flushUnsafe()
    const data = await loadSessionDataUnsafe(sessionId)
    if (options.observedMessages && (
      JSON.stringify(data.messages) !== JSON.stringify(options.observedMessages)
      || Object.entries(options.expectedSession || {}).some(([key, value]) => state.index.sessions[sessionId]?.[key] !== value)
    )) return { replaced: false, reason: 'history_changed' }
    const messages = newMessages.map((m) => ({
      ...m,
      id: m.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: m.timestamp || now()
    }))
    // This is the synchronous logical commit boundary after every awaited
    // load/CAS check; a cancelled summarizer cannot queue a replacement.
    options.signal?.throwIfAborted()
    queueDataOperation(sessionId, { kind: 'replace', value: messages, baseline: data.messages.map(message => message.id) })
    if (state.index.sessions[sessionId]) queueIndexOperation(sessionId, 'patch', { updatedAt: now() })
    if (options.observedMessages || state.options.flushIntervalMs <= 0) await flushUnsafe()
    return { replaced: true }
  })
}

export async function appendPart(sessionId, part) {
  return withLock(async () => {
    await ensureLoadedUnsafe()
    const normalized = newPart(part.type || "event", part)
    queueDataOperation(sessionId, { kind: 'part', value: normalized })
    if (state.index.sessions[sessionId]) queueIndexOperation(sessionId, 'patch', { updatedAt: now() })
    if (state.options.flushIntervalMs <= 0) await flushUnsafe()
    return normalized
  })
}

export async function getSession(sessionId) {
  return withLock(async () => {
    await ensureLoadedUnsafe()
    await flushUnsafe()
    const session = state.index.sessions[sessionId]
    if (!session) return null
    const data = await loadSessionDataUnsafe(sessionId)
    return {
      session,
      messages: [...data.messages],
      parts: [...data.parts]
    }
  })
}

export async function listSessions({ cwd = null, limit = 100, includeChildren = true, includeContent = false } = {}) {
  return withLock(async () => {
    await ensureLoadedUnsafe()
    let sessions = Object.values(state.index.sessions)
    if (cwd) sessions = sessions.filter((s) => s.cwd === cwd)
    if (!includeChildren) sessions = sessions.filter((s) => !s.parentSessionId)
    sessions = sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
    if (includeContent) {
      // Old indexes have no content marker. Hydrate only this bounded page, and
      // persist the marker without changing timestamps or deleting any history.
      for (const session of sessions) if (typeof session.hasContent !== 'boolean' || state.dirtySessions.has(session.id)) {
        const data = await loadSessionDataUnsafe(session.id)
        queueIndexOperation(session.id, 'patch', { hasContent: data.messages.length > 0 || data.parts.length > 0 })
      }
      await flushUnsafe()
      return sessions.map(session => state.index.sessions[session.id])
    }
    return sessions
  })
}

export async function getConversationHistory(sessionId, limit = 30, options = {}) {
  return withLock(async () => {
    await ensureLoadedUnsafe()
    const data = await loadSessionDataUnsafe(sessionId)
    const msgs = data.messages
    // Always preserve compaction summary (first message) — it must never be sliced off
    // by the limit window, otherwise the model loses all prior context
    const firstIsCompaction = msgs.length > 0 && (() => {
      const c = msgs[0].content
      if (typeof c === "string") return c.includes("<compaction-summary>")
      if (Array.isArray(c)) return c.some(block => typeof block === "string" ? block.includes("<compaction-summary>") : (block.type === "text" && typeof block.text === "string" && block.text.includes("<compaction-summary>")))
      return false
    })()
    const sliced = firstIsCompaction
      ? [msgs[0], ...msgs.slice(1).slice(-limit)]
      : msgs.slice(-limit)
    return sliced.map((msg) => {
      const base = {
        role: msg.role,
        content: msg.content
      }
      if (!options.includeMetadata) return base
      return {
        ...base,
        turnId: msg.turnId,
        step: msg.step,
        synthetic: msg.synthetic
      }
    })
  })
}

export async function markSessionStatus(sessionId, status) {
  return updateSession(sessionId, { status })
}

export async function exportSession(sessionId) {
  return getSession(sessionId)
}

export async function forkSession({ sessionId, newSessionId, title = null }) {
  return withLock(async () => {
    await ensureLoadedUnsafe()
    const source = state.index.sessions[sessionId]
    if (!source) return null

    const sourceData = await loadSessionDataUnsafe(sessionId)
    const child = {
      ...source,
      id: newSessionId,
      parentSessionId: source.id,
      forkFrom: source.id,
      title: title || `${source.title} (fork)`,
      createdAt: now(),
      updatedAt: now()
    }
    queueIndexOperation(newSessionId, 'fork', child)
    queueDataOperation(newSessionId, { kind: 'fork', value: {
      messages: sourceData.messages.map((m) => ({ ...m })),
      parts: sourceData.parts.map((p) => ({ ...p }))
    } })
    // Reserve and persist a fork atomically while holding the store lock.
    // Deferring its creation would let two processes acknowledge the same ID.
    await flushUnsafe()
    return child
  })
}

export async function applyReviewDecision(sessionId, decision) {
  return withLock(async () => {
    await ensureLoadedUnsafe()
    const session = state.index.sessions[sessionId]
    if (!session) return null
    queueIndexOperation(sessionId, 'review', {
      id: `rev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now(),
      ...decision
    })
    if (state.options.flushIntervalMs <= 0) await flushUnsafe()
    return state.index.sessions[sessionId]
  })
}

export async function setBudgetState(sessionId, budgetState) {
  return updateSession(sessionId, { budgetState })
}

export async function appendUserMessage(sessionId, content, extra = {}) {
  return appendMessage(sessionId, "user", content, extra)
}

export async function appendAssistantMessage(sessionId, content, extra = {}) {
  return appendMessage(sessionId, "assistant", content, extra)
}

export async function fsckSessionStore() {
  return withLock(async () => {
    await ensureLoadedUnsafe()
    await flushUnsafe()

    const report = {
      ok: true,
      checkedAt: now(),
      sessionsInIndex: Object.keys(state.index.sessions).length,
      filesOnDisk: 0,
      missingDataFiles: [],
      orphanDataFiles: [],
      invalidDataFiles: [],
      suggestions: []
    }

    const entries = await readdir(state.root, { withFileTypes: true }).catch(() => [])
    const diskSessionIds = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "index.json")
      .map((entry) => path.basename(entry.name, ".json"))
    report.filesOnDisk = diskSessionIds.length

    const indexIds = new Set(Object.keys(state.index.sessions))
    for (const sessionId of indexIds) {
      const file = sessionDataPath(sessionId)
      if (!(await exists(file))) {
        report.missingDataFiles.push(sessionId)
        continue
      }
      const parsed = await readJson(file, null)
      if (!parsed || !Array.isArray(parsed.messages) || !Array.isArray(parsed.parts)) {
        report.invalidDataFiles.push(sessionId)
      }
    }

    for (const sessionId of diskSessionIds) {
      if (!indexIds.has(sessionId)) {
        report.orphanDataFiles.push(sessionId)
      }
    }

    if (report.missingDataFiles.length || report.orphanDataFiles.length || report.invalidDataFiles.length) {
      report.ok = false
      if (report.missingDataFiles.length) report.suggestions.push("Run `kkcode session gc` to remove broken index entries.")
      if (report.orphanDataFiles.length) report.suggestions.push("Run `kkcode session gc --orphans-only` to clean orphan session files.")
      if (report.invalidDataFiles.length) report.suggestions.push("Backup invalid files then remove or restore them from snapshot.")
    } else {
      report.suggestions.push("No consistency issue detected.")
    }

    return report
  })
}

export async function deleteSession(sessionId) {
  return withLock(async () => {
    await ensureLoadedUnsafe()
    await flushUnsafe()
    sessionDataPath(sessionId)
    const session = state.index.sessions[sessionId]
    if (!session) return { deleted: false }
    const deletedIds = new Set([sessionId])
    for (let changed = true; changed;) {
      changed = false
      for (const item of Object.values(state.index.sessions)) {
        if (!deletedIds.has(item.id) && deletedIds.has(item.parentSessionId)) { deletedIds.add(item.id); changed = true }
      }
    }
    const records = []
    for (const id of deletedIds) records.push({ session: state.index.sessions[id], ...await readSessionData(id) })
    const backupDir = path.join(path.dirname(state.root), 'trash', 'sessions')
    await mkdir(backupDir, { recursive: true, mode: 0o700 })
    const backup = path.join(backupDir, `${sessionId}-${Date.now()}-${randomUUID()}.json`)
    await writeJson(backup, { version: 1, deletedAt: Date.now(), ...records[0], children: records.slice(1) })
    for (const id of deletedIds) queueIndexOperation(id, 'delete')
    await flushUnsafe()
    for (const id of deletedIds) {
      await unlink(sessionDataPath(id)).catch(error => { if (error.code !== 'ENOENT') throw error })
      state.sessionCache.delete(id)
    }
    return { deleted: true, deletedIds: [...deletedIds], recoverable: true, filesChanged: false }
  })
}

export async function gcSessionStore({ orphansOnly = false, maxAgeDays = 30 } = {}) {
  return withLock(async () => {
    await ensureLoadedUnsafe()
    await flushUnsafe()

    const removed = {
      orphanFiles: [],
      staleSessions: [],
      checkpointDirs: []
    }

    const entries = await readdir(state.root, { withFileTypes: true }).catch(() => [])
    const diskSessionIds = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "index.json")
      .map((entry) => path.basename(entry.name, ".json"))
    const indexIds = new Set(Object.keys(state.index.sessions))

    for (const sessionId of diskSessionIds) {
      if (!indexIds.has(sessionId)) {
        await unlink(sessionDataPath(sessionId)).catch(() => {})
        state.sessionCache.delete(sessionId)
        removed.orphanFiles.push(sessionId)
      }
    }

    if (!orphansOnly) {
      const cutoff = now() - Math.max(1, Number(maxAgeDays || 30)) * 24 * 60 * 60 * 1000
      const removableStatuses = new Set(["completed", "error", "stopped", "max-iterations", "no-progress", "heartbeat-timeout", "cancelled"])
      for (const [sessionId, session] of Object.entries(state.index.sessions)) {
        if (session.updatedAt > cutoff) continue
        if (!removableStatuses.has(session.status)) continue
        queueIndexOperation(sessionId, 'delete')
        state.sessionCache.delete(sessionId)
        await unlink(sessionDataPath(sessionId)).catch(() => {})
        removed.staleSessions.push(sessionId)
      }
    }

    const checkpointEntries = await readdir(sessionCheckpointRootPath(), { withFileTypes: true }).catch(() => [])
    const liveSessionIds = new Set(Object.keys(state.index.sessions))
    for (const entry of checkpointEntries) {
      if (!entry.isDirectory()) continue
      const sessionId = entry.name
      if (liveSessionIds.has(sessionId)) continue
      await rm(path.join(sessionCheckpointRootPath(), sessionId), { recursive: true, force: true }).catch(() => {})
      removed.checkpointDirs.push(sessionId)
    }

    state.dirtyIndex = true
    await flushUnsafe()
    return {
      removed,
      totalRemoved: removed.orphanFiles.length + removed.staleSessions.length + removed.checkpointDirs.length
    }
  })
}
