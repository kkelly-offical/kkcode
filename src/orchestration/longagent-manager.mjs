import path from "node:path"
import { mkdir, writeFile, unlink, stat } from "node:fs/promises"
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
const LOCK_RETRY_MS = 50

async function acquireLock(cwd) {
  const file = lockPath(cwd)
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      await writeFile(file, String(process.pid), { flag: "wx" })
      return true
    } catch (err) {
      if (err.code !== "EEXIST") throw err
      // Stale lock detection: if lock file is older than timeout, remove it
      try {
        const info = await stat(file)
        if (Date.now() - info.mtimeMs > LOCK_TIMEOUT_MS) {
          await unlink(file).catch(() => {})
          continue
        }
      } catch { /* lock disappeared, retry */ continue }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS))
    }
  }
  // Timeout: force-remove stale lock and proceed
  await unlink(file).catch(() => {})
  return false
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
  async update(sessionId, patch, cwd = process.cwd()) {
    await acquireLock(cwd)
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
  }
}
