import path from "node:path"
import { mkdir, writeFile, readFile, unlink, stat } from "node:fs/promises"
import { readJson, writeJson } from "../storage/json-store.mjs"
import { projectRootDir } from "../storage/paths.mjs"

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

export const LongAgentManager = {
  async update(sessionId, patch, cwd = process.cwd(), config = null) {
    const lockMs = Number(config?.agent?.longagent?.lock_timeout_ms || LOCK_TIMEOUT_MS)
    await acquireLock(cwd, lockMs)
    try {
      const state = await read(cwd)
      const current = state.sessions[sessionId] || {
        sessionId,
        status: "idle",
        phase: "L0",
        gateStatus: {},
        currentGate: "execution",
        recoveryCount: 0,
        planFrozen: false,
        currentStageId: null,
        stageIndex: 0,
        stageCount: 0,
        stageStatus: null,
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
  async stop(sessionId, cwd = process.cwd()) {
    const existing = await this.get(sessionId, cwd)
    if (!existing) return null
    return this.update(sessionId, { stopRequested: true }, cwd)
  },
  async clearStop(sessionId, cwd = process.cwd()) {
    const existing = await this.get(sessionId, cwd)
    if (!existing) return null
    return this.update(sessionId, { stopRequested: false }, cwd)
  },
  /**
   * Execute `fn` while holding the state lock.
   * Prevents TOCTOU races (e.g. read-status → git-merge).
   */
  async withLock(fn, cwd = process.cwd(), config = null) {
    const lockMs = Number(config?.agent?.longagent?.lock_timeout_ms || LOCK_TIMEOUT_MS)
    await acquireLock(cwd, lockMs)
    try {
      return await fn()
    } finally {
      await releaseLock(cwd)
    }
  }
}
