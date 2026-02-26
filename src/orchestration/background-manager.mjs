import path from "node:path"
import { spawn } from "node:child_process"
import { openSync, closeSync } from "node:fs"
import { readdir, unlink } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { readJson, writeJson } from "../storage/json-store.mjs"
import {
  ensureBackgroundTaskRuntimeDir,
  backgroundTaskCheckpointPath,
  backgroundTaskLogPath,
  backgroundTaskRuntimeDir
} from "../storage/paths.mjs"

const WORKER_ENTRY = fileURLToPath(new URL("./background-worker.mjs", import.meta.url))
const TERMINAL_STATES = new Set(["completed", "cancelled", "error", "interrupted"])

function now() {
  return Date.now()
}

function resolveWorkerTimeoutMs(config = {}, payload = {}) {
  const raw = Number(payload.workerTimeoutMs || config.background?.worker_timeout_ms || 900000)
  return Number.isFinite(raw) ? Math.max(1000, raw) : 900000
}

function resolveMaxParallel(config = {}) {
  const raw = Number(config.background?.max_parallel || 2)
  return Number.isFinite(raw) ? Math.max(1, raw) : 2
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function loadTask(id) {
  return readJson(backgroundTaskCheckpointPath(id), null)
}

async function saveTask(task) {
  await ensureBackgroundTaskRuntimeDir()
  await writeJson(backgroundTaskCheckpointPath(task.id), task)
  return task
}

// Process-level mutex to serialize patchTask calls (prevents same-process TOCTOU)
let patchLock = Promise.resolve()

async function patchTask(id, updater, { maxRetries = 3 } = {}) {
  const run = async () => {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const current = await loadTask(id)
      if (!current) return null
      const next = {
        ...current,
        ...updater(current),
        _version: (current._version || 0) + 1,
        updatedAt: now()
      }
      // Optimistic lock: re-read and verify version before write
      const check = await loadTask(id)
      if (check && (check._version || 0) !== (current._version || 0)) {
        if (attempt < maxRetries) continue // version changed, retry
        const err = new Error(`patchTask(${id}): version conflict after ${maxRetries} retries (expected ${current._version}, got ${check._version})`)
        err.code = "VERSION_CONFLICT"
        throw err
      }
      await saveTask(next)
      return next
    }
    return null
  }
  const result = patchLock.then(run, run)
  patchLock = result.then(() => undefined, () => undefined)
  return result
}

async function listTaskIds() {
  await ensureBackgroundTaskRuntimeDir()
  const entries = await readdir(backgroundTaskRuntimeDir(), { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.basename(entry.name, ".json"))
}

async function readAllTasks() {
  const ids = await listTaskIds()
  const out = []
  for (const id of ids) {
    const task = await loadTask(id)
    if (task) out.push(task)
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

function spawnWorker(taskId) {
  const logFile = backgroundTaskLogPath(taskId)
  let stderrFd = null
  try {
    stderrFd = openSync(logFile, "a")
  } catch {
    // directory may not exist yet or permission issue — fall back to ignore
  }
  let child
  try {
    child = spawn(process.execPath, [WORKER_ENTRY, "--task-id", taskId], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "ignore", stderrFd !== null ? stderrFd : "ignore"],
      env: {
        ...process.env,
        KKCODE_BACKGROUND_TASK_ID: taskId
      }
    })
  } catch (err) {
    // Close fd to prevent leak if spawn fails
    if (stderrFd !== null) {
      try { closeSync(stderrFd) } catch { /* ignore */ }
    }
    throw err
  }
  child.on("exit", (code) => {
    if (stderrFd !== null) {
      try { closeSync(stderrFd) } catch { /* already closed */ }
    }
    if (code && code !== 0) {
      patchTask(taskId, (current) => {
        if (current.status === "running") {
          return {
            status: "error",
            error: `worker process exited with code ${code}`,
            endedAt: now()
          }
        }
        return {}
      }).catch(() => {})
    }
  })
  child.unref()
  return child.pid
}

async function markStaleRunningTasks(config = {}) {
  const tasks = await readAllTasks()
  const timeoutDefault = Math.max(1000, Number(config.background?.worker_timeout_ms || 900000))
  let interrupted = 0

  for (const task of tasks) {
    if (task.status !== "running") continue
    const heartbeatAt = Number(task.lastHeartbeatAt || 0)
    const timeoutMs = resolveWorkerTimeoutMs(config, task.payload || {})
    const staleByHeartbeat = heartbeatAt > 0 && now() - heartbeatAt > timeoutMs + 5000
    const deadPid = task.workerPid ? !isProcessAlive(task.workerPid) : false
    const staleNoHeartbeat = heartbeatAt === 0 && now() - Number(task.startedAt || task.createdAt || now()) > timeoutDefault + 5000

    if (staleByHeartbeat || deadPid || staleNoHeartbeat) {
      await patchTask(task.id, () => ({
        status: "interrupted",
        endedAt: now(),
        error: deadPid
          ? "background worker exited unexpectedly"
          : staleByHeartbeat
            ? "background worker heartbeat timeout"
            : "background worker no heartbeat",
        workerPid: null
      }))
      interrupted += 1
    }
  }

  return interrupted
}

async function startPendingTasks(config = {}) {
  const maxParallel = resolveMaxParallel(config)
  const tasks = await readAllTasks()
  const running = tasks.filter((task) => task.status === "running").length
  let remainingSlots = Math.max(0, maxParallel - running)
  if (remainingSlots <= 0) return 0

  let started = 0
  const pending = tasks
    .filter((task) => task.status === "pending" && task.backgroundMode === "worker_process")
    .sort((a, b) => a.createdAt - b.createdAt)

  for (const task of pending) {
    if (remainingSlots <= 0) break
    let pid
    try {
      pid = spawnWorker(task.id)
    } catch (err) {
      await patchTask(task.id, () => ({
        status: "error",
        error: `spawn failed: ${err.message}`,
        endedAt: now()
      }))
      continue
    }
    const timeoutMs = resolveWorkerTimeoutMs(config, task.payload || {})
    await patchTask(task.id, (current) => ({
      status: "running",
      workerPid: pid,
      lastHeartbeatAt: now(),
      startedAt: current.startedAt || now(),
      payload: {
        ...(current.payload || {}),
        workerTimeoutMs: timeoutMs
      }
    }))
    remainingSlots -= 1
    started += 1
  }

  return started
}

async function runInline(task, run) {
  await patchTask(task.id, () => ({ status: "running", startedAt: now() }))
  try {
    const result = await run({
      taskId: task.id,
      isCancelled: async () => {
        const latest = await loadTask(task.id)
        return Boolean(latest?.cancelled)
      },
      log: async (line) => {
        await patchTask(task.id, (current) => ({
          logs: [...(current.logs || []), String(line)].slice(-300),
          lastHeartbeatAt: now()
        }))
      }
    })
    const latest = await loadTask(task.id)
    if (latest?.cancelled) {
      await patchTask(task.id, () => ({ status: "cancelled", endedAt: now() }))
      return
    }
    await patchTask(task.id, () => ({ status: "completed", result, endedAt: now() }))
  } catch (error) {
    const latest = await loadTask(task.id)
    await patchTask(task.id, () => ({
      status: latest?.cancelled ? "cancelled" : "error",
      error: error.message,
      endedAt: now()
    }))
  }
}

export const BackgroundManager = {
  async launch({ description, payload, run = null, config = {} }) {
    await ensureBackgroundTaskRuntimeDir()
    const id = `bg_${Math.random().toString(36).slice(2, 14)}`
    const timeoutMs = resolveWorkerTimeoutMs(config, payload || {})
    const task = {
      id,
      description,
      payload: {
        ...(payload || {}),
        workerTimeoutMs: timeoutMs
      },
      status: "pending",
      createdAt: now(),
      updatedAt: now(),
      startedAt: null,
      endedAt: null,
      logs: [],
      result: null,
      error: null,
      cancelled: false,
      backgroundMode: run ? "inline" : (config.background?.mode || "worker_process"),
      workerPid: null,
      lastHeartbeatAt: null,
      attempt: Number(payload?.attempt || 1),
      resumeToken: payload?.resumeToken || `resume_${Date.now()}`
    }
    await saveTask(task)

    if (run) {
      queueMicrotask(() => {
        runInline(task, run).catch((err) => {
          patchTask(task.id, () => ({
            status: "error",
            error: `inline task failed: ${err?.message || String(err)}`,
            endedAt: now()
          })).catch(() => {})
        })
      })
      return task
    }

    await this.tick(config)
    return (await loadTask(id)) || task
  },

  async launchDelegateTask({ description, payload, config = {} }) {
    return this.launch({
      description,
      payload: {
        ...payload,
        workerType: "delegate_task",
        attempt: Number(payload.attempt || 1),
        resumeToken: payload.resumeToken || `resume_${Date.now()}`
      },
      run: null,
      config
    })
  },

  async get(id) {
    await ensureBackgroundTaskRuntimeDir()
    return loadTask(id)
  },

  async list() {
    await ensureBackgroundTaskRuntimeDir()
    return readAllTasks()
  },

  async cancel(id) {
    const task = await loadTask(id)
    if (!task) return false
    await patchTask(id, (current) => ({
      cancelled: true,
      status: current.status === "pending" ? "cancelled" : current.status
    }))
    return true
  },

  async retry(id, config = {}) {
    const task = await loadTask(id)
    if (!task) return null
    if (!["error", "interrupted"].includes(task.status)) return null

    const nextAttempt = Number(task.attempt || 1) + 1
    const nextResumeToken = `resume_${Date.now()}`
    await patchTask(id, () => ({
      status: "pending",
      error: null,
      cancelled: false,
      endedAt: null,
      workerPid: null,
      lastHeartbeatAt: null,
      attempt: nextAttempt,
      resumeToken: nextResumeToken,
      payload: {
        ...(task.payload || {}),
        attempt: nextAttempt,
        resumeToken: nextResumeToken
      }
    }))

    await this.tick(config)
    return loadTask(id)
  },

  async clean({ maxAge = 7 * 24 * 60 * 60 * 1000 } = {}) {
    const tasks = await readAllTasks()
    const cutoff = now() - maxAge
    const removed = []
    for (const task of tasks) {
      if (!TERMINAL_STATES.has(task.status)) continue
      if (task.updatedAt > cutoff) continue
      await unlink(backgroundTaskCheckpointPath(task.id)).catch(() => {})
      await unlink(backgroundTaskLogPath(task.id)).catch(() => {})
      removed.push(task.id)
    }
    return removed
  },

  async tick(config = {}) {
    await markStaleRunningTasks(config)
    await startPendingTasks(config)
  }
}
