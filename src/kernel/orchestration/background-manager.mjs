import path from "node:path"
import { spawn } from "node:child_process"
import { openSync, closeSync } from "node:fs"
import { readdir, unlink } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { EventEmitter } from "node:events"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { INTERRUPTION_REASONS } from "./interruption-reason.mjs"
import { intersectDataPolicies } from '../permission/data-policy.mjs'
import { normalizeToolOutcome } from '../tool/result-outcome.mjs'
import { readBackgroundTask, createBackgroundTask, updateBackgroundTask, withBackgroundTaskLock, backgroundTaskOwner, backgroundTaskOwnerMatches } from './background-task-store.mjs'
import { registerBackgroundPromptOwner, hasBackgroundPromptOwner, bindBackgroundPromptWorker, releaseBackgroundPromptOwner } from './background-prompts.mjs'
import {
  ensureBackgroundTaskRuntimeDir,
  backgroundTaskCheckpointPath,
  backgroundTaskLogPath,
  backgroundTaskRuntimeDir
} from "../../storage/paths.mjs"

// Internal emitter for task settlement notifications
const settledEmitter = new EventEmitter()
settledEmitter.setMaxListeners(50)

const WORKER_ENTRY = fileURLToPath(new URL("./background-worker.mjs", import.meta.url))
const TERMINAL_STATES = new Set(["completed", "cancelled", "error", "interrupted"])
const inlineControllers = new Map()
const inlineStopControllers = new Map()
const inlineOwnerReleases = new Map()

function now() {
  return Date.now()
}

function clipText(text, max = 160) {
  const value = String(text || "").trim().replace(/\s+/g, " ")
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

function extractTaskResultPreview(task) {
  if (task?.status === "completed") {
    const reply = String(task?.result?.reply || task?.result?.summary || task?.result?.output || (typeof task?.result === 'string' ? task.result : '')).trim()
    if (reply) return clipText(reply, 180)
    return "completed successfully"
  }
  if (task?.error) return clipText(task.error, 180)
  if (task?.interruptionReason) return clipText(task.interruptionReason, 120)
  return ""
}

/**
 * 已经广播过终态的 `id#attempt`。
 *
 * 一次落地有两条互不知情的观察路径（父进程内的 patchTask 跨越、worker 退出后的
 * 回读复核），两条都会走到广播 —— 去重放在这里，而不是让每个订阅者各自防抖。
 *
 * 键里带 attempt 而不是只用 id：`retry()` 是同一个 id 的**第二次生命**，它的结果
 * 同样要把主代理叫回来。只按 id 去重的话，重试成功后没有任何人会知道。
 */
const settledEmittedKeys = new Set()
/** 去重记忆的上限。没有上限的话，长跑会话里它只涨不落。 */
const SETTLED_MEMORY_LIMIT = 500

/**
 * 向全局 EventBus 广播一次任务终态。同一个 id 只广播一次，返回是否真的发了。
 *
 * sessionId 取父会话：后台任务自己的 subSessionId 对界面没有意义，
 * 而父会话才是「谁在等这个结果」。
 */
async function emitTaskSettled(task) {
  if (!task?.id || !TERMINAL_STATES.has(task.status)) return false
  const key = `${task.id}#${Number(task.attempt || 1)}`
  if (settledEmittedKeys.has(key)) return false
  settledEmittedKeys.add(key)
  if (settledEmittedKeys.size > SETTLED_MEMORY_LIMIT) {
    const keep = [...settledEmittedKeys].slice(-Math.floor(SETTLED_MEMORY_LIMIT / 2))
    settledEmittedKeys.clear()
    for (const id of keep) settledEmittedKeys.add(id)
  }
  await EventBus.emit({
    type: EVENT_TYPES.TASK_SETTLED,
    sessionId: task.payload?.parentSessionId || null,
    payload: {
      id: task.id,
      status: task.status,
      attempt: Number(task.attempt || 1),
      description: String(task.description || ""),
      resultPreview: extractTaskResultPreview(task),
      subagent: task.payload?.subagent || task.payload?.subagentType || null,
      subSessionId: task.payload?.subSessionId || null,
      worktreePreserved: task.result?.worktree_preserved === true,
      worktreePath: task.result?.worktree_path || null
    }
  }).catch(() => {})
  return true
}

/**
 * worker 进程退出后的终态复核。
 *
 * worker 是在**自己的进程**里把 checkpoint 写成 completed 的 —— 父进程的 patchTask
 * 从没见过那次跨越，所以父进程唯一可靠的观察点就是 child 的 exit 回调。而
 * 「进程退出」不等于「任务终态」（可能是崩溃、可能状态还停在 running），
 * 必须回读 checkpoint 确认，不能拿退出码当结论。
 */
async function confirmSettledAfterExit(taskId) {
  const task = await loadTask(taskId).catch(() => null)
  return emitTaskSettled(task)
}

function nextActionForTask(task) {
  switch (task?.status) {
    case "pending":
      return "wait for the worker to start or inspect later with background show/background_output"
    case "running":
      return "wait for completion or inspect logs with background show/background_output"
    case "completed":
      if (task?.result?.worktree_preserved === true && task.result?.worktree_path) {
        return `changes are held in a preserved worktree, NOT in the workspace; apply with: kkcode background apply --id ${task.id} (or discard with: kkcode background discard --id ${task.id})`
      }
      return "read the final result and file changes via background_output"
    case "error":
      return "inspect the error/log tail and use background retry if the task is safe to rerun"
    case "interrupted":
      return "inspect the interruption reason and use background retry when appropriate"
    case "cancelled":
      return "inspect retained output and prior effects before deciding whether any new work is safe; cancellation is not rollback"
    default:
      return "inspect the task record for more detail"
  }
}

function summarizeTask(task) {
  if (!task) return null
  return {
    id: task.id,
    description: task.description,
    status: task.status,
    attempt: Number(task.attempt || 1),
    background_mode: task.backgroundMode || null,
    subagent: task.payload?.subagent || task.payload?.subagentType || null,
    execution_mode: task.payload?.executionMode || null,
    group_id: task.payload?.groupId || null,
    group_label: task.payload?.groupLabel || null,
    session_id: task.payload?.subSessionId || null,
    parent_session_id: task.payload?.parentSessionId || null,
    stage_id: task.payload?.stageId || null,
    logical_task_id: task.payload?.logicalTaskId || null,
    created_at: task.createdAt || null,
    started_at: task.startedAt || null,
    ended_at: task.endedAt || null,
    interruption_reason: task.interruptionReason || null,
    next_action: nextActionForTask(task),
    log_lines: Array.isArray(task.logs) ? task.logs.length : 0,
    log_tail: Array.isArray(task.logs) ? task.logs.slice(-10) : [],
    ...(task.payload?.workerType === 'bash' ? {cwd: task.payload.cwd, lifetime: task.payload.lifetime || 'command',
      timeout_ms: task.payload.commandTimeoutMs, stop_requested: Boolean(task.stopRequestedAt)} : {}),
    result_preview: extractTaskResultPreview(task),
    worktree_preserved: task.result?.worktree_preserved === true,
    worktree_path: task.result?.worktree_path || null
  }
}

function summarizeTaskList(tasks = []) {
  const counts = {
    pending: 0,
    running: 0,
    completed: 0,
    cancelled: 0,
    error: 0,
    interrupted: 0
  }
  for (const task of tasks) {
    if (counts[task.status] !== undefined) counts[task.status] += 1
  }
  return {
    total: tasks.length,
    active: counts.pending + counts.running,
    counts,
    recent_terminal: tasks
      .filter((task) => TERMINAL_STATES.has(task.status))
      .slice(0, 3)
      .map((task) => summarizeTask(task)),
    parallel_groups: summarizeParallelGroups(tasks)
  }
}

function summarizeParallelGroups(tasks = []) {
  const groups = new Map()
  for (const task of tasks) {
    const payload = task.payload || {}
    const groupId = payload.groupId || payload.parentSessionId || "ungrouped"
    const groupLabel = payload.groupLabel || payload.parentSessionId || "ungrouped"
    if (!groups.has(groupId)) {
      groups.set(groupId, {
        group_id: groupId,
        group_label: groupLabel,
        parent_session_id: payload.parentSessionId || null,
        total: 0,
        active: 0,
        counts: { pending: 0, running: 0, completed: 0, cancelled: 0, error: 0, interrupted: 0 },
        lanes: []
      })
    }
    const group = groups.get(groupId)
    const status = task.status || "unknown"
    group.total += 1
    if (group.counts[status] !== undefined) group.counts[status] += 1
    if (status === "pending" || status === "running") group.active += 1
    group.lanes.push({
      id: task.id,
      status,
      subagent: payload.subagent || payload.subagentType || null,
      execution_mode: payload.executionMode || null,
      logical_task_id: payload.logicalTaskId || null,
      session_id: payload.subSessionId || null,
      description: task.description || "",
      result_preview: extractTaskResultPreview(task)
    })
  }
  return [...groups.values()].sort((a, b) => b.active - a.active || b.total - a.total)
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
  return readBackgroundTask(id)
}

async function saveTask(task) {
  return createBackgroundTask(task)
}

// Process-level mutex to serialize patchTask calls (prevents same-process TOCTOU)
let patchLock = Promise.resolve()

async function patchTask(id, updater, options = {}) {
  // 跨入终态的那一份记在这里，广播放到锁外做 —— 订阅者（TUI 唤醒会提交一个新回合）
  // 可能跑很久，在锁里发会把后面所有 patchTask 都排在它后面。
  let crossedIntoTerminal = null
  const run = async () => {
    const { current, next } = await updateBackgroundTask(id, updater, options)
    if (!next) return null
    // Emit only after the checkpoint commit and outside the process lock.
    if (TERMINAL_STATES.has(next.status) && !TERMINAL_STATES.has(current.status)) {
      settledEmitter.emit("task-settled", { id: next.id, status: next.status })
      crossedIntoTerminal = next
    }
    return next
  }
  const result = patchLock.then(run, run)
  patchLock = result.then(() => undefined, () => undefined)
  const next = await result
  if (crossedIntoTerminal) await emitTaskSettled(crossedIntoTerminal)
  return next
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

function spawnWorker(task) {
  const taskId = task.id
  const owner = backgroundTaskOwner(task)
  const logFile = backgroundTaskLogPath(taskId)
  let stderrFd = null
  try {
    stderrFd = openSync(logFile, "a")
  } catch {
    // directory may not exist yet or permission issue — fall back to ignore
  }
  let child
  try {
    child = spawn(process.execPath, [WORKER_ENTRY, "--task-id", taskId, '--attempt', String(owner.attempt), '--resume-token', owner.resumeToken || ''], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "ignore", stderrFd !== null ? stderrFd : "ignore", ...(hasBackgroundPromptOwner(taskId) ? ["ipc"] : [])],
      env: {
        ...process.env,
        KKCODE_BACKGROUND_TASK_ID: taskId
      }
    })
  } catch (err) {
    releaseBackgroundPromptOwner(taskId)
    // Close fd to prevent leak if spawn fails
    if (stderrFd !== null) {
      try { closeSync(stderrFd) } catch { /* ignore */ }
    }
    throw err
  }
  const releasePrompts = bindBackgroundPromptWorker(child, task)
  child.channel?.unref()
  child.on("exit", (code) => {
    releasePrompts()
    if (stderrFd !== null) {
      try { closeSync(stderrFd) } catch { /* already closed */ }
    }
    const settle = async () => {
      if (code && code !== 0) {
        await patchTask(taskId, (current) => {
          if (current.status === "running") {
            return {
              status: "error",
              error: `worker process exited with code ${code}`,
              endedAt: now()
            }
          }
          return
        }, { owner, preserveTerminal: true })
      } else {
        // Worker exited cleanly (code 0) — notify waiters so they re-check status
        settledEmitter.emit("task-settled", { id: taskId, status: "exited", code: 0 })
      }
      // 两条分支都要复核：worker 可能已经在自己进程里写好了终态（上面的 patchTask
      // 因此看不到跨越），也可能只是进程没了而 checkpoint 还停在 running。
      await confirmSettledAfterExit(taskId)
    }
    settle().catch((err) => {
      console.warn(`[kkcode] background settle failed for exited worker ${taskId}: ${err?.message || err}`)
    })
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
        interruptionReason: deadPid ? INTERRUPTION_REASONS.INTERRUPT : INTERRUPTION_REASONS.TIMEOUT,
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
      pid = spawnWorker(task)
    } catch (err) {
      await patchTask(task.id, () => ({
        status: "error",
        error: `spawn failed: ${err.message}`,
        endedAt: now()
      }))
      continue
    }
    const timeoutMs = resolveWorkerTimeoutMs(config, task.payload || {})
    await patchTask(task.id, (current) => current.cancelled || TERMINAL_STATES.has(current.status) ? {} : ({
      status: "running",
      workerPid: pid,
      lastHeartbeatAt: now(),
      startedAt: current.startedAt || now(),
      payload: {
        ...(current.payload || {}),
        workerTimeoutMs: timeoutMs
      }
    }), { owner: backgroundTaskOwner(task), preserveTerminal: true })
    remainingSlots -= 1
    started += 1
  }

  return started
}

async function runInline(task, run) {
  const controller = new AbortController()
  const stopController = new AbortController()
  const owner = backgroundTaskOwner(task)
  const writeOptions = { owner, preserveTerminal: true }
  inlineControllers.set(task.id, controller)
  inlineStopControllers.set(task.id, stopController)
  let poll
  try {
    const active = await patchTask(task.id, current => current.cancelled || TERMINAL_STATES.has(current.status)
      ? {} : { status: "running", startedAt: now(), lastHeartbeatAt: now() }, writeOptions)
    if (!active || active.cancelled || TERMINAL_STATES.has(active.status)) return
    if (active.stopRequestedAt) stopController.abort()
    // Another CLI process can persist a cancellation, so the same-process
    // controller is the fast path rather than the only path.
    let checking = false
    poll = setInterval(async () => {
      if (checking || controller.signal.aborted) return
      checking = true
      try {
        const latest = await loadTask(task.id)
        if (!backgroundTaskOwnerMatches(latest, owner) || latest?.cancelled) controller.abort()
        else if (latest.stopRequestedAt && !stopController.signal.aborted) stopController.abort()
        else if (latest?.status === 'running' && now() - Number(latest.lastHeartbeatAt || 0) >= 1000) {
          await patchTask(task.id, current => current.status === 'running' ? { lastHeartbeatAt: now() } : {}, writeOptions)
        }
      }
      catch (error) { controller.abort(error) }
      finally { checking = false }
    }, 50)
    const result = await run({
      taskId: task.id,
      signal: controller.signal,
      stopSignal: stopController.signal,
      isCancelled: async () => {
        const latest = await loadTask(task.id)
        return !backgroundTaskOwnerMatches(latest, owner) || Boolean(latest?.cancelled)
      },
      log: async (line) => {
        await patchTask(task.id, (current) => ({
          logs: [...(current.logs || []), String(line)].slice(-300),
          logSequence: (current.logSequence ?? current.logs?.length ?? 0) + 1,
          lastHeartbeatAt: now()
        }), writeOptions)
      }
    })
    const outcome = normalizeToolOutcome(result, controller.signal)
    await patchTask(task.id, current => ({
      status: current.cancelled || outcome.status === 'cancelled' ? 'cancelled' : outcome.ok ? 'completed' : 'error',
      result,
      error: outcome.error,
      endedAt: now(),
      interruptionReason: current.cancelled || outcome.status === 'cancelled' ? INTERRUPTION_REASONS.USER_CANCEL : null
    }), writeOptions)
  } catch (error) {
    const latest = await loadTask(task.id)
    if (!backgroundTaskOwnerMatches(latest, owner)) return
    await patchTask(task.id, current => ({
      status: current.cancelled ? "cancelled" : "error",
      error: error.message,
      interruptionReason: current.cancelled ? INTERRUPTION_REASONS.USER_CANCEL : null,
      endedAt: now()
    }), writeOptions)
  } finally {
    clearInterval(poll)
    if (inlineControllers.get(task.id) === controller) inlineControllers.delete(task.id)
    if (inlineStopControllers.get(task.id) === stopController) inlineStopControllers.delete(task.id)
    inlineOwnerReleases.get(task.id)?.()
    inlineOwnerReleases.delete(task.id)
  }
}

export const BackgroundManager = {
  async launch({ description, payload, run = null, config = {}, signal = null }) {
    signal?.throwIfAborted()
    const dataPolicy = intersectDataPolicies(/** @type {any} */ (config).data_policy, payload?.dataPolicy)
    await ensureBackgroundTaskRuntimeDir()
    const id = `bg_${Math.random().toString(36).slice(2, 14)}`
    const timeoutMs = resolveWorkerTimeoutMs(config, payload || {})
    const task = {
      id,
      description,
      payload: {
        ...(payload || {}),
        ...(dataPolicy === undefined ? {} : { dataPolicy }),
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
      interruptionReason: null,
      cancelled: false,
      backgroundMode: run ? "inline" : (/** @type {any} */ (config).background?.mode || "worker_process"),
      workerPid: null,
      lastHeartbeatAt: null,
      attempt: Number(payload?.attempt || 1),
      resumeToken: payload?.resumeToken || `resume_${Date.now()}`
    }
    await saveTask(task)
    if (!run && task.payload.workerType === 'delegate_task') registerBackgroundPromptOwner(id)

    if (run) {
      if (signal) {
        const onAbort = () => {
          inlineControllers.get(id)?.abort(signal.reason)
          // Cancellation is durably recorded as well as signalled in-process.
          // A storage failure must not keep the owned process running.
          void this.cancel(id).catch(() => {})
        }
        signal.addEventListener('abort', onAbort, { once: true })
        inlineOwnerReleases.set(id, () => signal.removeEventListener('abort', onAbort))
        if (signal.aborted) onAbort()
      }
      queueMicrotask(() => {
        runInline(task, run).catch((err) => {
          patchTask(task.id, () => ({
            status: "error",
            error: `inline task failed: ${err?.message || String(err)}`,
            endedAt: now()
          }), { owner: backgroundTaskOwner(task), preserveTerminal: true }).catch(() => {})
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

  summarize(task) {
    return summarizeTask(task)
  },

  summarizeList(tasks) {
    return summarizeTaskList(tasks)
  },

  summarizeParallel(tasks) {
    return summarizeParallelGroups(tasks)
  },

  async list() {
    await ensureBackgroundTaskRuntimeDir()
    return readAllTasks()
  },

  async summary() {
    await ensureBackgroundTaskRuntimeDir()
    return summarizeTaskList(await readAllTasks())
  },

  async requestStop(id, {parentSessionId = null} = {}) {
    const task = await loadTask(id)
    if (!task || parentSessionId != null && task.payload?.parentSessionId !== parentSessionId) return false
    if (task.payload?.lifetime !== 'service' || task.payload?.workerType !== 'bash') return this.cancel(id, {parentSessionId})
    await patchTask(id, current => {
      if (parentSessionId != null && current.payload?.parentSessionId !== parentSessionId) throw new Error('Background task owner changed')
      return TERMINAL_STATES.has(current.status) ? {} : {stopRequestedAt: current.stopRequestedAt || now()}
    }, {owner: backgroundTaskOwner(task), preserveTerminal: true})
    inlineStopControllers.get(id)?.abort()
    return true
  },

  async cancel(id, { parentSessionId = null } = {}) {
    const task = await loadTask(id)
    if (!task || parentSessionId != null && task.payload?.parentSessionId !== parentSessionId) return false
    if (TERMINAL_STATES.has(task.status)) return true
    let cancelled
    try {
      cancelled = await patchTask(id, (current) => {
        // Recheck inside the checkpoint lock, not only before awaiting it.
        if (parentSessionId != null && current.payload?.parentSessionId !== parentSessionId) {
          throw Object.assign(new Error('Background task is not owned by this session'), { code: 'background_task_scope' })
        }
        return TERMINAL_STATES.has(current.status) ? {} : {
          cancelled: true,
          status: current.status === "pending" ? "cancelled" : current.status,
          interruptionReason: INTERRUPTION_REASONS.USER_CANCEL,
          ...(current.status === 'pending' ? { endedAt: now() } : {})
        }
      }, parentSessionId == null ? {} : { owner: backgroundTaskOwner(task) })
    } catch (error) {
      if (['background_task_scope', 'background_task_stale_owner'].includes(error.code)) return false
      throw error
    }
    if (!cancelled) return false
    releaseBackgroundPromptOwner(id)
    inlineControllers.get(id)?.abort()
    return true
  },

  async retry(id, config = {}) {
    const task = await loadTask(id)
    if (!task) return null
    if (!["error", "interrupted"].includes(task.status)) return null

    const nextAttempt = Number(task.attempt || 1) + 1
    registerBackgroundPromptOwner(id)
    const nextResumeToken = `resume_${Date.now()}`
    await patchTask(id, () => ({
      status: "pending",
      error: null,
      interruptionReason: null,
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
    const skippedPreserved = []
    for (const task of tasks) {
      if (!TERMINAL_STATES.has(task.status)) continue
      if (task.updatedAt > cutoff) continue
      // 保留了 worktree 的任务不能连记录一起删：checkpoint 是找回
      // worktree_path 的唯一线索，删了它 tmpdir 里的副本就成永久孤儿。
      // 先 background apply / discard 处置掉，记录才允许随 clean 过期。
      if (task.result?.worktree_preserved === true && task.result?.worktree_path) {
        skippedPreserved.push(task.id)
        continue
      }
      await withBackgroundTaskLock(task.id, async () => {
        const current = await loadTask(task.id)
        if (!current || !TERMINAL_STATES.has(current.status) || current.updatedAt > cutoff || current.result?.worktree_preserved === true && current.result?.worktree_path) return
        await unlink(backgroundTaskCheckpointPath(task.id)).catch(() => {})
        await unlink(backgroundTaskLogPath(task.id)).catch(() => {})
        removed.push(task.id)
      })
    }
    return { removed, skipped_preserved: skippedPreserved }
  },

  /**
   * Wait for any task to reach a terminal state, or timeout.
   * Returns immediately if a settlement event fires before the deadline.
   */
  waitForSettled(timeoutMs = 300) {
    return /** @type {Promise<void>} */ (new Promise((resolve) => {
      const timer = setTimeout(() => {
        settledEmitter.removeListener("task-settled", onSettled)
        resolve()
      }, timeoutMs)
      function onSettled() {
        clearTimeout(timer)
        settledEmitter.removeListener("task-settled", onSettled)
        resolve()
      }
      settledEmitter.once("task-settled", onSettled)
    }))
  },

  /**
   * Wait for any of the specified tasks to settle, or timeout.
   * Unlike waitForSettled(), this filters by task ID — unrelated task
   * settlements won't cause a spurious wakeup.
   * @param {string[]} taskIds - IDs to watch
   * @param {number} timeoutMs - max wait before resolving anyway
   * @returns {Promise<{id:string,status:string}|null|void>} settled task info, null on timeout; void when delegating to waitForSettled (empty taskIds)
   */
  waitForAny(taskIds, timeoutMs = 300) {
    if (!taskIds || !taskIds.length) {
      return this.waitForSettled(timeoutMs)
    }
    const idSet = new Set(taskIds)
    return new Promise((resolve) => {
      let done = false
      const timer = setTimeout(() => {
        done = true
        settledEmitter.removeListener("task-settled", onSettled)
        resolve(null)
      }, timeoutMs)
      function onSettled(event) {
        if (done) return
        if (idSet.has(event.id)) {
          done = true
          clearTimeout(timer)
          settledEmitter.removeListener("task-settled", onSettled)
          resolve(event)
        }
        // unrelated event — .once() already removed us, re-register
        if (!done) settledEmitter.once("task-settled", onSettled)
      }
      settledEmitter.once("task-settled", onSettled)
    })
  },

  async waitForTask(id, { timeoutMs = 30000, tickMs = 250, config = {} } = {}) {
    const deadline = Date.now() + Math.max(100, Number(timeoutMs || 30000))
    while (Date.now() < deadline) {
      await this.tick(config)
      const task = await loadTask(id)
      if (!task) return null
      if (TERMINAL_STATES.has(task.status)) return task
      const remaining = Math.max(1, deadline - Date.now())
      await this.waitForAny([id], Math.min(Number(tickMs || 250), remaining))
    }
    return loadTask(id)
  },

  async tick(config = {}) {
    await markStaleRunningTasks(config)
    await startPendingTasks(config)
  }
}
