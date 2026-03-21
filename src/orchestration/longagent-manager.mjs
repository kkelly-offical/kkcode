import path from "node:path"
import { mkdir, writeFile, readFile, unlink, stat } from "node:fs/promises"
import { readJson, writeJson } from "../storage/json-store.mjs"
import { projectRootDir } from "../storage/paths.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"

function statePath(cwd = process.cwd()) {
  return path.join(projectRootDir(cwd), "longagent-state.json")
}

function lockPath(cwd = process.cwd()) {
  return statePath(cwd) + ".lock"
}

async function ensure(cwd = process.cwd()) {
  await mkdir(projectRootDir(cwd), { recursive: true })
}

const LOCK_TIMEOUT_MS = 5000
const LOCK_STALE_MS = LOCK_TIMEOUT_MS * 0.8  // 4000ms — detect stale before timeout
const LOCK_RETRY_INIT_MS = 50
const LOCK_RETRY_MAX_MS = 500

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function tryRemoveStaleLock(file, staleMs = LOCK_STALE_MS) {
  try {
    const content = await readFile(file, "utf-8")
    const [pidStr] = content.split(":")
    const pid = Number(pidStr)
    // If PID is valid and process is dead, remove immediately
    if (pid > 0 && !isProcessAlive(pid)) {
      await unlink(file).catch(() => {})
      return true
    }
    // Otherwise check mtime-based staleness
    const info = await stat(file)
    if (Date.now() - info.mtimeMs > staleMs) {
      await unlink(file).catch(() => {})
      return true
    }
  } catch {
    // lock disappeared or unreadable — retry
    return true
  }
  return false
}

async function acquireLock(cwd, lockTimeoutMs = LOCK_TIMEOUT_MS) {
  await ensure(cwd)
  const file = lockPath(cwd)
  const staleMs = lockTimeoutMs * 0.8
  const deadline = Date.now() + lockTimeoutMs
  let retryMs = LOCK_RETRY_INIT_MS

  while (Date.now() < deadline) {
    try {
      await writeFile(file, `${process.pid}:${Date.now()}`, { flag: "wx" })
      return true
    } catch (err) {
      if (err.code !== "EEXIST") throw err
      const removed = await tryRemoveStaleLock(file, staleMs)
      if (removed) continue
      // Exponential backoff: 50 → 100 → 200 → 400 → 500 (capped)
      await new Promise((r) => setTimeout(r, retryMs))
      retryMs = Math.min(retryMs * 2, LOCK_RETRY_MAX_MS)
    }
  }

  // Final attempt after timeout
  const removed = await tryRemoveStaleLock(file, staleMs)
  if (removed) {
    try {
      await writeFile(file, `${process.pid}:${Date.now()}`, { flag: "wx" })
      return true
    } catch { /* another process grabbed it */ }
  }
  throw new Error(`Failed to acquire lock after ${lockTimeoutMs}ms: ${file}`)
}

async function releaseLock(cwd) {
  await unlink(lockPath(cwd)).catch(() => {})
}

async function read(cwd = process.cwd()) {
  await ensure(cwd)
  return readJson(statePath(cwd), { sessions: {} })
}

async function write(data, cwd = process.cwd()) {
  await ensure(cwd)
  await writeJson(statePath(cwd), data)
}

async function patchSession(sessionId, patch, cwd = process.cwd()) {
  const state = await read(cwd)
  const current = state.sessions[sessionId]
  if (!current) return null
  state.sessions[sessionId] = {
    ...current,
    ...patch,
    updatedAt: Date.now()
  }
  await write(state, cwd)
  return state.sessions[sessionId]
}

function normalizeStageReport(report = {}, fallback = {}) {
  const stageId = String(report.stageId || fallback.stageId || "").trim()
  const stageName = String(report.stageName || fallback.stageName || "").trim()
  const successCount = Math.max(0, Number(report.successCount || 0))
  const failCount = Math.max(0, Number(report.failCount || 0))
  const retryCount = Math.max(0, Number(report.retryCount || 0))
  const remainingFiles = [...new Set(
    (Array.isArray(report.remainingFiles) ? report.remainingFiles : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
  )]
  const fileChanges = Array.isArray(report.fileChanges) ? report.fileChanges : []
  const totalCost = Number.isFinite(Number(report.totalCost)) ? Number(report.totalCost) : 0
  const updatedAt = Date.now()
  return {
    stageId,
    stageName,
    stageIndex: Math.max(0, Number(report.stageIndex ?? fallback.stageIndex ?? 0)),
    stageCount: Math.max(0, Number(report.stageCount ?? fallback.stageCount ?? 0)),
    status: failCount === 0 ? "pass" : "fail",
    successCount,
    failCount,
    retryCount,
    remainingFiles: remainingFiles.slice(0, 12),
    remainingFilesCount: remainingFiles.length,
    fileChangesCount: fileChanges.length,
    totalCost,
    completionMarkerSeen: report.completionMarkerSeen === true,
    allSuccess: report.allSuccess === true || failCount === 0,
    updatedAt
  }
}

function normalizeCheckpoint(checkpoint = {}, fallback = {}) {
  const phase = String(checkpoint.phase || fallback.phase || "").trim()
  const summary = String(checkpoint.summary || "").trim()
  if (!phase || !summary) return null
  return {
    id: String(checkpoint.id || `chk_${Date.now().toString(36)}`),
    phase,
    kind: String(checkpoint.kind || "phase"),
    stageId: checkpoint.stageId ? String(checkpoint.stageId) : null,
    taskId: checkpoint.taskId ? String(checkpoint.taskId) : null,
    summary,
    createdAt: Number(checkpoint.createdAt || Date.now())
  }
}

function normalizeBackgroundTask(task = {}) {
  const id = String(task.id || task.backgroundTaskId || "").trim()
  if (!id) return null
  return {
    backgroundTaskId: id,
    backgroundTaskStatus: String(task.status || task.backgroundTaskStatus || "pending"),
    backgroundTaskAttempt: Math.max(1, Number(task.attempt || task.backgroundTaskAttempt || 1)),
    backgroundTaskUpdatedAt: Number(task.updatedAt || task.backgroundTaskUpdatedAt || Date.now())
  }
}

export const LongAgentManager = {
  async update(sessionId, patch, cwd = process.cwd(), config = null) {
    const lockMs = Number(config?.agent?.longagent?.lock_timeout_ms || LOCK_TIMEOUT_MS)
    await acquireLock(cwd, lockMs)
    try {
      const state = await read(cwd)
      const current = state.sessions[sessionId] || {
        sessionId,
        status: "idle",
        objective: "",
        providerType: null,
        model: null,
        maxIterations: 0,
        phase: "L0",
        gateStatus: {},
        currentGate: "execution",
        recoveryCount: 0,
        planFrozen: false,
        stagePlan: null,
        currentStageId: null,
        stageIndex: 0,
        stageCount: 0,
        stageStatus: null,
        lastStageReport: null,
        stageReports: [],
        checkpoints: [],
        backgroundTaskId: null,
        backgroundTaskStatus: null,
        backgroundTaskAttempt: 0,
        backgroundTaskUpdatedAt: null,
        taskProgress: {},
        remainingFiles: [],
        remainingFilesCount: 0,
        lastGateFailures: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        heartbeatAt: null,
        iterations: 0,
        lastMessage: ""
      }
      state.sessions[sessionId] = {
        ...current,
        ...patch,
        updatedAt: Date.now()
      }
      await write(state, cwd)
      return state.sessions[sessionId]
    } finally {
      await releaseLock(cwd)
    }
  },
  async get(sessionId, cwd = process.cwd()) {
    const state = await read(cwd)
    return state.sessions[sessionId] || null
  },
  async list(cwd = process.cwd()) {
    const state = await read(cwd)
    return Object.values(state.sessions).sort((a, b) => b.updatedAt - a.updatedAt)
  },
  async linkBackgroundTask(sessionId, task, cwd = process.cwd(), config = null) {
    const normalized = normalizeBackgroundTask(task)
    if (!normalized) return this.get(sessionId, cwd)
    return this.update(sessionId, normalized, cwd, config)
  },
  async clearBackgroundTask(sessionId, cwd = process.cwd(), config = null) {
    return this.update(sessionId, {
      backgroundTaskId: null,
      backgroundTaskStatus: null,
      backgroundTaskAttempt: 0,
      backgroundTaskUpdatedAt: Date.now()
    }, cwd, config)
  },
  async stop(sessionId, cwd = process.cwd()) {
    await acquireLock(cwd)
    try {
      const result = await patchSession(sessionId, { stopRequested: true }, cwd)
      if (!result) return null
      await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_STOP_REQUESTED, sessionId, payload: { sessionId } }).catch(() => {})
      return result
    } finally {
      await releaseLock(cwd)
    }
  },
  async clearStop(sessionId, cwd = process.cwd()) {
    await acquireLock(cwd)
    try {
      return patchSession(sessionId, { stopRequested: false }, cwd)
    } finally {
      await releaseLock(cwd)
    }
  },
  async checkpoint(sessionId, checkpoint, cwd = process.cwd(), config = null) {
    const lockMs = Number(config?.agent?.longagent?.lock_timeout_ms || LOCK_TIMEOUT_MS)
    await acquireLock(cwd, lockMs)
    try {
      const state = await read(cwd)
      const current = state.sessions[sessionId]
      if (!current) return null
      const normalized = normalizeCheckpoint(checkpoint, current)
      if (!normalized) return current
      const checkpoints = [...(Array.isArray(current.checkpoints) ? current.checkpoints : []), normalized].slice(-30)
      state.sessions[sessionId] = {
        ...current,
        checkpoints,
        updatedAt: Date.now()
      }
      await write(state, cwd)
      return state.sessions[sessionId]
    } finally {
      await releaseLock(cwd)
    }
  },
  async pushStageReport(sessionId, report, cwd = process.cwd(), config = null) {
    const lockMs = Number(config?.agent?.longagent?.lock_timeout_ms || LOCK_TIMEOUT_MS)
    await acquireLock(cwd, lockMs)
    try {
      const state = await read(cwd)
      const current = state.sessions[sessionId]
      if (!current) return null
      const normalized = normalizeStageReport(report, current)
      const prior = Array.isArray(current.stageReports) ? current.stageReports : []
      const stageReports = [...prior, normalized].slice(-12)
      state.sessions[sessionId] = {
        ...current,
        lastStageReport: normalized,
        stageReports,
        updatedAt: Date.now()
      }
      await write(state, cwd)
      return state.sessions[sessionId]
    } finally {
      await releaseLock(cwd)
    }
  },
  /**
   * Execute `fn` while holding the state lock.
   * Prevents TOCTOU races (e.g. read-status → git-merge).
   * Includes heartbeat to prevent stale detection during long operations.
   */
  async withLock(fn, cwd = process.cwd(), config = null) {
    const lockMs = Number(config?.agent?.longagent?.lock_timeout_ms || LOCK_TIMEOUT_MS)
    await acquireLock(cwd, lockMs)
    // Heartbeat: touch lock file periodically to prevent stale detection
    const heartbeatMs = Math.max(Math.floor(lockMs * 0.3), 1000)
    const file = lockPath(cwd)
    const heartbeat = setInterval(() => {
      writeFile(file, `${process.pid}:${Date.now()}`).catch(() => {})
    }, heartbeatMs)
    try {
      return await fn()
    } finally {
      clearInterval(heartbeat)
      await releaseLock(cwd)
    }
  }
}
