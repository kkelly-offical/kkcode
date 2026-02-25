import { randomUUID } from "node:crypto"
import path from "node:path"
import { access, readdir, unlink, rm } from "node:fs/promises"
import {
  ensureUserRoot,
  ensureSessionShardRoot,
  sessionIndexPath,
  sessionDataPath,
  legacySessionStorePath,
  sessionShardRootPath,
  sessionCheckpointRootPath
} from "../storage/paths.mjs"
import { readJson, writeJson } from "../storage/json-store.mjs"

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

const state = {
  loaded: false,
  index: defaultIndex(),
  sessionCache: new Map(),
  dirtyIndex: false,
  dirtySessions: new Set(),
  flushTimer: null,
  options: {
    sessionShardEnabled: true,
    flushIntervalMs: 1000
  }
}

const LOCK_TIMEOUT_MS = 30000

let lock = Promise.resolve()
function withLock(fn) {
  const run = lock.then(fn, fn)
  lock = run.then(
    () => undefined,
    () => undefined
  )
  return Promise.race([
    run,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("[store] withLock timeout after 30s")), LOCK_TIMEOUT_MS)
    })
  ])
}

function scheduleFlush() {
  if (state.options.flushIntervalMs <= 0) return
  if (state.flushTimer) return
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null
    flushNow().catch((err) => {
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
  if (!state.loaded) return
  await ensureUserRoot()
  await ensureSessionShardRoot()

  for (const sessionId of [...state.dirtySessions]) {
    const data = state.sessionCache.get(sessionId) || defaultSessionData()
    await writeJson(sessionDataPath(sessionId), data)
    state.dirtySessions.delete(sessionId)
  }

  if (state.dirtyIndex) {
    state.index.updatedAt = now()
    await writeJson(sessionIndexPath(), state.index)
    state.dirtyIndex = false
  }
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
  const data = normalizeSessionData(await readJson(sessionDataPath(sessionId), defaultSessionData()))
  state.sessionCache.set(sessionId, data)
  return data
}

async function migrateLegacyStoreIfNeededUnsafe() {
  const indexFile = sessionIndexPath()
  if (await exists(indexFile)) {
    state.index = await readJson(indexFile, defaultIndex())
    return
  }

  const legacy = await readJson(legacySessionStorePath(), null)
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
  if (state.loaded) return
  await ensureUserRoot()
  await ensureSessionShardRoot()
  await migrateLegacyStoreIfNeededUnsafe()
  state.loaded = true
}

async function ensureLoaded() {
  return withLock(async () => {
    await ensureLoadedUnsafe()
  })
}

export function configureSessionStore(options = {}) {
  if (typeof options.sessionShardEnabled === "boolean") {
    state.options.sessionShardEnabled = options.sessionShardEnabled
  }
  if (Number.isInteger(options.flushIntervalMs) && options.flushIntervalMs >= 0) {
    state.options.flushIntervalMs = options.flushIntervalMs
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
    const existing = state.index.sessions[sessionId]
    const createdAt = existing?.createdAt || now()
    state.index.sessions[sessionId] = {
      id: sessionId,
      mode,
      model,
      providerType,
      cwd,
      title: title || existing?.title || `${mode}:${model}`,
      status,
      parentSessionId: parentSessionId || existing?.parentSessionId || null,
      forkFrom: forkFrom || existing?.forkFrom || null,
      retryMeta: existing?.retryMeta || null,
      patchRefs: existing?.patchRefs || [],
      reviewDecisions: existing?.reviewDecisions || [],
      budgetState: existing?.budgetState || null,
      createdAt,
      updatedAt: now()
    }
    await loadSessionDataUnsafe(sessionId)
    markDirty(sessionId)
    if (state.options.flushIntervalMs <= 0) await flushUnsafe()
    return state.index.sessions[sessionId]
  })
}

export async function updateSession(sessionId, patch) {
  return withLock(async () => {
    await ensureLoadedUnsafe()
    const current = state.index.sessions[sessionId]
    if (!current) return null
    state.index.sessions[sessionId] = {
      ...current,
      ...patch,
      updatedAt: now()
    }
    markDirty(sessionId)
    if (state.options.flushIntervalMs <= 0) await flushUnsafe()
    return state.index.sessions[sessionId]
  })
}

export async function appendMessage(sessionId, role, content, extra = {}) {
  return withLock(async () => {
    await ensureLoadedUnsafe()
    const data = await loadSessionDataUnsafe(sessionId)
    const message = newMessage(role, content, extra)
    data.messages.push(message)
    if (state.index.sessions[sessionId]) state.index.sessions[sessionId].updatedAt = now()
    markDirty(sessionId)
    if (state.options.flushIntervalMs <= 0) await flushUnsafe()
    return message
  })
}

export async function replaceMessages(sessionId, newMessages) {
  return withLock(async () => {
    await ensureLoadedUnsafe()
    const data = await loadSessionDataUnsafe(sessionId)
    data.messages = newMessages.map((m) => ({
      ...m,
      id: m.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: m.timestamp || now()
    }))
    if (state.index.sessions[sessionId]) state.index.sessions[sessionId].updatedAt = now()
    markDirty(sessionId)
    if (state.options.flushIntervalMs <= 0) await flushUnsafe()
  })
}

export async function appendPart(sessionId, part) {
  return withLock(async () => {
    await ensureLoadedUnsafe()
    const data = await loadSessionDataUnsafe(sessionId)
    const normalized = newPart(part.type || "event", part)
    data.parts.push(normalized)
    if (state.index.sessions[sessionId]) state.index.sessions[sessionId].updatedAt = now()
    markDirty(sessionId)
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

export async function listSessions({ cwd = null, limit = 100, includeChildren = true } = {}) {
  return withLock(async () => {
    await ensureLoadedUnsafe()
    let sessions = Object.values(state.index.sessions)
    if (cwd) sessions = sessions.filter((s) => s.cwd === cwd)
    if (!includeChildren) sessions = sessions.filter((s) => !s.parentSessionId)
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
  })
}

export async function getConversationHistory(sessionId, limit = 30) {
  return withLock(async () => {
    await ensureLoadedUnsafe()
    const data = await loadSessionDataUnsafe(sessionId)
    return data.messages.slice(-limit).map((msg) => ({
      role: msg.role,
      content: msg.content // preserves array content blocks (images) as-is
    }))
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
    state.index.sessions[newSessionId] = child
    state.sessionCache.set(newSessionId, {
      messages: sourceData.messages.map((m) => ({ ...m })),
      parts: sourceData.parts.map((p) => ({ ...p }))
    })
    markDirty(newSessionId)
    if (state.options.flushIntervalMs <= 0) await flushUnsafe()
    return child
  })
}

export async function applyReviewDecision(sessionId, decision) {
  return withLock(async () => {
    await ensureLoadedUnsafe()
    const session = state.index.sessions[sessionId]
    if (!session) return null
    session.reviewDecisions = session.reviewDecisions || []
    session.reviewDecisions.push({
      id: `rev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now(),
      ...decision
    })
    session.updatedAt = now()
    markDirty(sessionId)
    if (state.options.flushIntervalMs <= 0) await flushUnsafe()
    return session
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

    const entries = await readdir(sessionShardRootPath(), { withFileTypes: true }).catch(() => [])
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

export async function gcSessionStore({ orphansOnly = false, maxAgeDays = 30 } = {}) {
  return withLock(async () => {
    await ensureLoadedUnsafe()
    await flushUnsafe()

    const removed = {
      orphanFiles: [],
      staleSessions: [],
      checkpointDirs: []
    }

    const entries = await readdir(sessionShardRootPath(), { withFileTypes: true }).catch(() => [])
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
        delete state.index.sessions[sessionId]
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
