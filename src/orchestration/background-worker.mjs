import { appendFile } from "node:fs/promises"
import { readJson, writeJson } from "../storage/json-store.mjs"
import { ensureBackgroundTaskRuntimeDir, backgroundTaskCheckpointPath, backgroundTaskLogPath } from "../storage/paths.mjs"
import { buildContext } from "../context.mjs"
import { ToolRegistry } from "../tool/registry.mjs"
import { executeTurn } from "../session/engine.mjs"
import { LongAgentManager } from "./longagent-manager.mjs"

function now() {
  return Date.now()
}

function argValue(flag) {
  const idx = process.argv.indexOf(flag)
  if (idx < 0) return null
  return process.argv[idx + 1] || null
}

function makeAbortError(reason = "aborted") {
  const err = new Error(reason)
  err.code = "ABORT_ERR"
  return err
}

function isAbortError(error) {
  return error?.code === "ABORT_ERR" || error?.name === "AbortError"
}

async function readTask(taskId) {
  return readJson(backgroundTaskCheckpointPath(taskId), null)
}

async function patchTask(taskId, updater) {
  const current = await readTask(taskId)
  if (!current) return null
  const next = {
    ...current,
    ...updater(current),
    updatedAt: now()
  }
  await writeJson(backgroundTaskCheckpointPath(taskId), next)
  return next
}

let _maxLogLines = 300

let _logBuffer = []
let _logFlushTimer = null
const LOG_FLUSH_INTERVAL_MS = 3000

async function flushLogBuffer(taskId) {
  if (!_logBuffer.length) return
  const lines = _logBuffer.splice(0)
  await patchTask(taskId, (current) => ({
    logs: [...(current.logs || []), ...lines].slice(-_maxLogLines),
    lastHeartbeatAt: now()
  }))
}

async function appendTaskLog(taskId, line) {
  await appendFile(backgroundTaskLogPath(taskId), `${line}\n`, "utf8")
  _logBuffer.push(String(line))
  if (!_logFlushTimer) {
    _logFlushTimer = setTimeout(async () => {
      _logFlushTimer = null
      await flushLogBuffer(taskId).catch(() => {})
    }, LOG_FLUSH_INTERVAL_MS)
  }
}

function resolveLongAgentSessionId(payload = {}, task = {}) {
  return String(payload.longagentSessionId || payload.sessionId || task.id || "").trim() || null
}

async function syncLongAgentBackgroundState(task, patch = {}) {
  const payload = task?.payload || {}
  const sessionId = resolveLongAgentSessionId(payload, task)
  if (!sessionId) return null
  const cwd = payload.cwd || process.cwd()
  return LongAgentManager.update(sessionId, {
    objective: String(payload.prompt || ""),
    ...patch
  }, cwd)
}

async function runDelegateTask(task, signal) {
  const payload = task.payload || {}
  const cwd = payload.cwd || process.cwd()
  process.chdir(cwd)

  const ctx = await buildContext({ cwd })
  _maxLogLines = Number(ctx.configState.config?.background?.max_log_lines || 300)
  await ToolRegistry.initialize({
    config: ctx.configState.config,
    cwd
  })
  const { CustomAgentRegistry } = await import("../agent/custom-agent-loader.mjs")
  await CustomAgentRegistry.initialize(cwd)

  const providerType = payload.providerType || ctx.configState.config.provider.default
  const providerDefault = ctx.configState.config.provider[providerType]
  const model = payload.model || providerDefault?.default_model

  const out = await executeTurn({
    prompt: String(payload.prompt || ""),
    mode: "agent",
    model,
    providerType,
    sessionId: payload.subSessionId,
    configState: ctx.configState,
    signal,
    allowQuestion: payload.allowQuestion !== true ? false : true,
    toolContext: {
      taskId: task.id,
      stageId: payload.stageId || null,
      logicalTaskId: payload.logicalTaskId || null
    }
  })

  const plannedFiles = Array.isArray(payload.plannedFiles)
    ? payload.plannedFiles.map((item) => String(item || "").trim()).filter(Boolean)
    : []
  const completedFilesFromTools = out.toolEvents
    .filter((event) => ["write", "edit"].includes(event.name) && event.status === "completed")
    .map((event) => {
      const p = event.args?.path
      return p ? String(p).trim() : ""
    })
    .filter(Boolean)

  const fileChanges = out.toolEvents
    .flatMap((event) => Array.isArray(event?.metadata?.fileChanges) ? event.metadata.fileChanges : [])
    .map((item) => ({
      path: String(item?.path || "").trim(),
      addedLines: Math.max(0, Number(item?.addedLines || 0)),
      removedLines: Math.max(0, Number(item?.removedLines || 0)),
      stageId: item?.stageId ? String(item.stageId) : (payload.stageId || ""),
      taskId: item?.taskId ? String(item.taskId) : (payload.logicalTaskId || "")
    }))
    .filter((item) => item.path)

  const completedFileSet = new Set(
    completedFilesFromTools.filter((file) => plannedFiles.length === 0 || plannedFiles.includes(file))
  )
  const completedFiles = [...completedFileSet]
  const remainingFiles = plannedFiles.filter((file) => !completedFileSet.has(file))

  return {
    session_id: payload.subSessionId,
    parent_session_id: payload.parentSessionId || null,
    subagent: payload.subagent || null,
    reply: out.reply,
    tool_events: out.toolEvents?.length || 0,
    completed_files: completedFiles,
    remaining_files: remainingFiles,
    file_changes: fileChanges,
    cost: out.cost,
    budget_warnings: out.budgetWarnings || []
  }
}

async function runLongAgentSession(task, signal) {
  const payload = task.payload || {}
  const cwd = payload.cwd || process.cwd()
  process.chdir(cwd)
  await syncLongAgentBackgroundState(task, {
    status: "queued",
    backgroundTaskId: task.id,
    backgroundTaskStatus: task.status || "running",
    backgroundTaskAttempt: Number(task.attempt || 1),
    backgroundTaskUpdatedAt: Date.now(),
    lastMessage: "background longagent worker attached"
  })

  const ctx = await buildContext({ cwd })
  _maxLogLines = Number(ctx.configState.config?.background?.max_log_lines || 300)
  await ToolRegistry.initialize({
    config: ctx.configState.config,
    cwd
  })
  const { CustomAgentRegistry } = await import("../agent/custom-agent-loader.mjs")
  await CustomAgentRegistry.initialize(cwd)

  const providerType = payload.providerType || ctx.configState.config.provider.default
  const providerDefault = ctx.configState.config.provider[providerType]
  const model = payload.model || providerDefault?.default_model

  const out = await executeTurn({
    prompt: String(payload.prompt || ""),
    mode: "longagent",
    model,
    providerType,
    sessionId: payload.longagentSessionId || payload.sessionId || task.id,
    configState: ctx.configState,
    signal,
    allowQuestion: false,
    maxIterations: Number(payload.maxIterations || 0),
    toolContext: {
      backgroundTaskId: task.id
    }
  })

  return {
    session_id: payload.longagentSessionId || payload.sessionId || task.id,
    reply: out.reply,
    status: out.status,
    phase: out.phase,
    stage_index: out.stageIndex,
    stage_count: out.stageCount,
    current_stage_id: out.currentStageId || null,
    recovery_count: out.recoveryCount || 0,
    last_message: out.lastMessage || "",
    file_changes: Array.isArray(out.fileChanges) ? out.fileChanges : []
  }
}

const SILENT_ERROR_PATTERNS = [
  /provider[\s._-]*error/i,
  /api[\s._-]*timeout/i,
  /rate[\s._-]?limit/i,
  /\b(429|503|502|500)\b/,
  /missing api key/i,
  /stream idle timeout/i,
  /\b(econnreset|econnrefused|etimedout)\b/i,
  /budget exceeded/i
]

function detectSilentError(result, payload) {
  const reply = String(result?.reply || "")
  const toolEvents = Number(result?.tool_events || 0)
  const plannedFiles = Array.isArray(payload?.plannedFiles) ? payload.plannedFiles : []
  const completedFiles = Array.isArray(result?.completed_files) ? result.completed_files : []
  const remainingFiles = Array.isArray(result?.remaining_files) ? result.remaining_files : []

  // Guard: tasks without plannedFiles (review/analysis) skip all detection
  if (plannedFiles.length === 0) return { hasError: false, errorMessage: "" }

  // Guard: [TASK_COMPLETE] marker present — trust the agent's self-report
  if (reply.toLowerCase().includes("[task_complete]")) return { hasError: false, errorMessage: "" }

  // Guard: has tool activity and substantial reply — likely real work done
  if (toolEvents > 0 && reply.length >= 200) return { hasError: false, errorMessage: "" }

  // Pattern matching: known provider error signatures in reply
  for (const pattern of SILENT_ERROR_PATTERNS) {
    if (pattern.test(reply)) {
      return { hasError: true, errorMessage: `silent provider error detected: ${reply.slice(0, 200)}` }
    }
  }

  // Heuristic: planned files exist but none completed, low activity
  if (completedFiles.length === 0
    && remainingFiles.length === plannedFiles.length
    && (reply.length < 200 || toolEvents === 0)) {
    return { hasError: true, errorMessage: `heuristic: no files completed, no tool activity (reply ${reply.length} chars, ${toolEvents} tool events)` }
  }

  return { hasError: false, errorMessage: "" }
}

async function main() {
  const taskId = argValue("--task-id") || process.env.KKCODE_BACKGROUND_TASK_ID || null
  if (!taskId) {
    process.exitCode = 1
    return
  }

  await ensureBackgroundTaskRuntimeDir()
  const task = await readTask(taskId)
  if (!task) {
    process.exitCode = 1
    return
  }

  if (task.cancelled) {
    await patchTask(taskId, () => ({
      status: "cancelled",
      endedAt: now()
    }))
    process.exitCode = 0
    return
  }

  await patchTask(taskId, () => ({
    status: "running",
    workerPid: process.pid,
    workerToken: process.env.KKCODE_BACKGROUND_TASK_TOKEN || null,
    workerHostPid: Number(process.env.KKCODE_BACKGROUND_HOST_PID || 0) || null,
    workerBootConfirmedAt: now(),
    workerBootDeadlineAt: null,
    startedAt: now(),
    lastHeartbeatAt: now()
  }))
  await syncLongAgentBackgroundState(task, {
    status: "running",
    backgroundTaskId: task.id,
    backgroundTaskStatus: "running",
    backgroundTaskAttempt: Number(task.attempt || 1),
    backgroundTaskUpdatedAt: now(),
    lastMessage: "background worker running"
  }).catch(() => {})

  const abortController = new AbortController()
  const parentPid = process.ppid
  const heartbeatTimer = setInterval(() => {
    patchTask(taskId, () => ({ lastHeartbeatAt: now() })).catch(() => {})
  }, 2000)

  const cancelPoll = setInterval(() => {
    // Orphan detection: if parent process died, self-terminate
    try { process.kill(parentPid, 0) } catch {
      if (!abortController.signal.aborted) {
        abortController.abort(makeAbortError("parent process exited, worker orphaned"))
      }
      return
    }
    readTask(taskId).then((latest) => {
      if (latest?.cancelled && !abortController.signal.aborted) {
        abortController.abort(makeAbortError("cancelled by user"))
      }
    }).catch(() => {})
  }, 1500)

  const timeoutMs = Math.max(1000, Number(task.payload?.workerTimeoutMs || 900000))
  const timeoutTimer = setTimeout(() => {
    if (!abortController.signal.aborted) {
      abortController.abort(makeAbortError(`worker timeout after ${timeoutMs}ms`))
    }
  }, timeoutMs)
  let exitCode = 0

  try {
    await appendTaskLog(taskId, `task started (worker pid=${process.pid})`)

    const latest = await readTask(taskId)
    const workerType = latest?.payload?.workerType || "unknown"
    let result
    if (workerType === "delegate_task") {
      result = await runDelegateTask(latest, abortController.signal)
      const silentCheck = detectSilentError(result, latest.payload)
      if (silentCheck.hasError) {
        await appendTaskLog(taskId, `silent error detected: ${silentCheck.errorMessage}`)
        await patchTask(taskId, () => ({
          status: "error",
          result,
          error: silentCheck.errorMessage,
          endedAt: now(),
          lastHeartbeatAt: now(),
          workerPid: null,
          workerToken: null
        }))
        exitCode = 1
        return
      }
    } else if (workerType === "longagent_session") {
      result = await runLongAgentSession(latest, abortController.signal)
    } else {
      throw new Error(`unsupported workerType: ${workerType}`)
    }

    await appendTaskLog(taskId, "task completed")
    await patchTask(taskId, () => ({
      status: "completed",
      result,
      error: null,
      endedAt: now(),
      lastHeartbeatAt: now(),
      workerPid: null,
      workerToken: null
    }))
    await syncLongAgentBackgroundState(latest, {
      backgroundTaskId: taskId,
      backgroundTaskStatus: "completed",
      backgroundTaskAttempt: Number(latest?.attempt || 1),
      backgroundTaskUpdatedAt: now(),
      lastMessage: "background worker completed"
    }).catch(() => {})
    exitCode = 0
  } catch (error) {
    const latest = await readTask(taskId)
    const cancelled = latest?.cancelled
    const aborted = isAbortError(error)
    if (cancelled) {
      await appendTaskLog(taskId, "task cancelled")
      await patchTask(taskId, () => ({
        status: "cancelled",
        endedAt: now(),
        error: null,
        workerPid: null,
        workerToken: null
      }))
      await syncLongAgentBackgroundState(latest, {
        backgroundTaskId: taskId,
        backgroundTaskStatus: "cancelled",
        backgroundTaskAttempt: Number(latest?.attempt || 1),
        backgroundTaskUpdatedAt: now(),
        status: "cancelled",
        lastMessage: "background worker cancelled"
      }).catch(() => {})
      exitCode = 0
      return
    }

    if (aborted) {
      await appendTaskLog(taskId, `task interrupted: ${error.message}`)
      await patchTask(taskId, () => ({
        status: "interrupted",
        error: error.message,
        endedAt: now(),
        workerPid: null,
        workerToken: null
      }))
      await syncLongAgentBackgroundState(latest, {
        backgroundTaskId: taskId,
        backgroundTaskStatus: "interrupted",
        backgroundTaskAttempt: Number(latest?.attempt || 1),
        backgroundTaskUpdatedAt: now(),
        status: "interrupted",
        lastMessage: error.message
      }).catch(() => {})
      exitCode = 2
      return
    }

    await appendTaskLog(taskId, `task error: ${error.message}`)
    await patchTask(taskId, () => ({
      status: "error",
      error: error.message,
      endedAt: now(),
      workerPid: null,
      workerToken: null
    }))
    await syncLongAgentBackgroundState(latest, {
      backgroundTaskId: taskId,
      backgroundTaskStatus: "error",
      backgroundTaskAttempt: Number(latest?.attempt || 1),
      backgroundTaskUpdatedAt: now(),
      status: "error",
      lastMessage: error.message
    }).catch(() => {})
    exitCode = 1
  } finally {
    clearInterval(heartbeatTimer)
    clearInterval(cancelPoll)
    clearTimeout(timeoutTimer)
    if (_logFlushTimer) {
      clearTimeout(_logFlushTimer)
      _logFlushTimer = null
    }
    await flushLogBuffer(taskId).catch(() => {})
    process.exitCode = exitCode
  }
}

main().catch(() => {
  process.exitCode = 1
})
