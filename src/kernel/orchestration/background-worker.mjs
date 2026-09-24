import { runtimeCwd } from "../core/runtime-context.mjs"
import { appendFile, access, copyFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { readJson, writeJson } from "../../storage/json-store.mjs"
import { ensureBackgroundTaskRuntimeDir, backgroundTaskCheckpointPath, backgroundTaskLogPath } from "../../storage/paths.mjs"
import { createKernel } from "../index.mjs"
import { loadConfig } from '../../config/load-config.mjs'
import { flushNow } from "../session/store.mjs"
import { extractEditFeedbackFromToolEvents } from "../../observability/edit-diagnostics.mjs"
import { INTERRUPTION_REASONS, normalizeInterruptionReason } from "./interruption-reason.mjs"
import { checkWorkspaceTrust } from "../permission/workspace-trust.mjs"
import { removeDetachedWorktree } from "./worktree-handoff.mjs"
import { createBackgroundPromptClient } from './background-prompts.mjs'
import * as git from "../../util/git.mjs"

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

async function copyWorkspaceConfigFiles(sourceRoot, targetRoot) {
  const candidates = [
    "kkcode.config.json",
    "kkcode.config.yaml",
    ".kkcode/config.json",
    ".kkcode/config.yaml"
  ]
  for (const rel of candidates) {
    const from = path.join(sourceRoot, rel)
    try {
      await access(from)
    } catch {
      continue
    }
    const to = path.join(targetRoot, rel)
    await mkdir(path.dirname(to), { recursive: true })
    await copyFile(from, to)
  }
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
let _logFlushPromise = null
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
    _logFlushTimer = setTimeout(() => {
      _logFlushTimer = null
      _logFlushPromise = flushLogBuffer(taskId)
        .catch(() => {})
        .finally(() => {
          _logFlushPromise = null
        })
    }, LOG_FLUSH_INTERVAL_MS)
  }
}

async function ensureDelegatedSession({ kernel, executionMode, parentSessionId, subSessionId }) {
  if (executionMode !== "fork_context") return
  if (!parentSessionId) throw new Error("fork_context requires a parent session")

  const existing = await kernel.sessions.getSession(subSessionId)
  if (existing) return

  const forked = await kernel.sessions.forkSession({
    sessionId: parentSessionId,
    newSessionId: subSessionId,
    title: `fork:${subSessionId}`
  })

  if (!forked) {
    throw new Error(`fork_context parent session not found: ${parentSessionId}`)
  }

  await flushNow()
}

async function runDelegateTask(task, signal) {
  const payload = task.payload || {}
  const repoCwd = payload.cwd || runtimeCwd()
  const executionMode = String(payload.executionMode || "fresh_agent").trim().toLowerCase() || "fresh_agent"
  if (!["fresh_agent", "fork_context"].includes(executionMode)) {
    throw new Error(`unsupported task.execution_mode: ${payload.executionMode}`)
  }
  if (payload.allowQuestion === true && !process.send) {
    throw new Error("background delegated questions require a live parent prompt channel")
  }

  let effectiveCwd = repoCwd
  let worktree = null
  let inheritedTrustState = null

  if (String(payload.isolation || "default").trim().toLowerCase() === "worktree") {
    // A linked worktree has a different path and therefore no separate trust
    // record. Re-check the persisted parent workspace instead of trusting a
    // task payload, then carry that decision into the isolated context.
    inheritedTrustState = await checkWorkspaceTrust({
      cwd: repoCwd,
      cliTrust: false,
      isTTY: false
    })
    const created = await git.createDetachedWorktree(repoCwd, task.id)
    if (!created.ok) {
      throw new Error(`worktree setup failed: ${created.error}`)
    }
    worktree = created
    effectiveCwd = created.path
    // 信任按 cwd 哈希存 —— worktree 是新路径，天然不在信任存储里。父仓库
    // 已受信任时把信任带给 worktree（内容是同一份已授信的提交，不扩大
    // 攻击面）；不带的话 provider 供应链防护会拿 worktree 路径重查存储，
    // 项目配置里定义了 provider 的仓库在 worktree 里全部拒绝推理 ——
    // worker 空转、任务被静默错误检测拦下。清理时撤销（见 removeDetachedWorktree）。
    if (inheritedTrustState?.trusted === true) {
      const { persistTrust } = await import("../permission/workspace-trust.mjs")
      await persistTrust(effectiveCwd).catch(() => {})
    }
  }

  let out
  let kernel = null
  const promptClient = process.send ? createBackgroundPromptClient(process, { signal }) : null
  try {
    if (worktree) {
      await copyWorkspaceConfigFiles(repoCwd, effectiveCwd)
    }
    process.chdir(effectiveCwd)

    // 1.0.0 阶段 2c：worker 是独立进程入口，createKernel() 在这里重启内核
    // （§7.3 显式契约，见 src/kernel/kernel.mjs 头注释）。配置加载、storage
    // 层注入与信任策略在句柄内完成；进程级默认引擎的信任标志由 2b 桥安装 ——
    // 此前 worker 从不设置它，engine.check() 第一行就抛 "workspace not trusted"，
    // 被 loop 吞成 tool error，后台子智能体只能纯文本作答，任务还标成 completed
    // （0.5.8 修的就是这个）。
    //
    // boot 推迟到 ensureDelegatedSession 之后：fork_context 的父会话校验属于输入
    // 校验，必须先于扩展启动出局 —— boot 的副作用（技能种子包落盘等）会弄脏
    // worktree，让错误路径的 isClean 清理误判（background-worker-e2e 钉住这条）。
    kernel = await createKernel({
      cwd: effectiveCwd,
      configState: await loadConfig(effectiveCwd, { adminDataPolicy: payload.dataPolicy }),
      boot: false,
      ...(promptClient ? { handlers: { onPermissionPrompt: promptClient.onPermissionPrompt, onQuestionPrompt: promptClient.onQuestionPrompt } } : {}),
      ...(inheritedTrustState ? { trustState: inheritedTrustState } : {})
    })
    _maxLogLines = Number(kernel.configState.config?.background?.max_log_lines || 300)

    const providerType = payload.providerType || kernel.configState.config.provider.default
    const providerDefault = kernel.configState.config.provider[providerType]
    const model = payload.model || providerDefault?.default_model

    await ensureDelegatedSession({
      kernel,
      executionMode,
      parentSessionId: payload.parentSessionId || null,
      subSessionId: payload.subSessionId
    })
    await kernel.bootExtensions()

    out = await kernel.executeTurn({
      prompt: String(payload.prompt || ""),
      mode: "agent",
      model,
      providerType,
      baseUrl: payload.baseUrl || null,
      apiKeyEnv: payload.apiKeyEnv || null,
      sessionId: payload.subSessionId,
      signal,
      runSpec: payload.runSpec || null,
      allowQuestion: payload.allowQuestion === true,
      toolContext: {
        ...(payload.runSpec?.toolContext?.skillToolGroups ? { skillToolGroups: payload.runSpec.toolContext.skillToolGroups } : {}),
        taskId: task.id,
        stageId: payload.stageId || null,
        logicalTaskId: payload.logicalTaskId || null
      }
    })
    await flushNow()
  } catch (error) {
    if (worktree) {
      await (kernel?.shutdown() ?? Promise.resolve()).catch(() => {})
      process.chdir(repoCwd)
      const clean = await git.isClean(worktree.path, 5000).catch(() => false)
      if (clean) {
        const cleanup = await removeDetachedWorktree(worktree, repoCwd)
          .catch((cleanupError) => ({
            ok: false,
            message: cleanupError?.message || String(cleanupError)
          }))
        if (!cleanup.ok) {
          error.message = `${error.message}; worktree cleanup failed: ${cleanup.message || "unknown error"}`
        }
      }
    }
    throw error
  } finally {
    promptClient?.close()
    // shutdown 幂等；若 catch 路径的 shutdown 失败，这里重试（与旧的双
    // McpRegistry.shutdown 语义一致），kernel 为 null（boot 失败）时跳过
    await (kernel?.shutdown() ?? Promise.resolve()).catch(() => {})
    if (worktree) {
      process.chdir(repoCwd)
    }
  }

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
  const editFeedback = extractEditFeedbackFromToolEvents(out.toolEvents || [])

  const completedFileSet = new Set(
    completedFilesFromTools.filter((file) => plannedFiles.length === 0 || plannedFiles.includes(file))
  )
  const completedFiles = [...completedFileSet]
  const remainingFiles = plannedFiles.filter((file) => !completedFileSet.has(file))
  let worktreePreserved = Boolean(worktree && (fileChanges.length > 0 || completedFiles.length > 0))
  let worktreeCleanupError = null

  if (worktree && !worktreePreserved) {
    const cleanup = await removeDetachedWorktree(worktree, repoCwd)
      .catch((error) => ({ ok: false, message: error?.message || String(error) }))
    if (!cleanup.ok) {
      worktreePreserved = true
      worktreeCleanupError = cleanup.message || "unknown cleanup error"
    }
  }

  return {
    session_id: payload.subSessionId,
    parent_session_id: payload.parentSessionId || null,
    subagent: payload.subagent || null,
    execution_mode: executionMode,
    reply: out.reply,
    tool_events: out.toolEvents?.length || 0,
    completed_files: completedFiles,
    remaining_files: remainingFiles,
    file_changes: fileChanges,
    edit_feedback: editFeedback,
    cost: out.cost,
    budget_warnings: out.budgetWarnings || [],
    isolation: String(payload.isolation || "default"),
    worktree_path: worktreePreserved ? worktree.path : null,
    worktree_preserved: worktreePreserved,
    worktree_cleanup_error: worktreeCleanupError
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
  /budget exceeded/i,
  // 权限被拒也是一种「模型只能干说话」的静默失败。worker 缺 setTrusted 那个
  // bug 期间，每次工具调用都抛这句、被吞成 tool error，任务照样标 completed ——
  // 加进模式表，让同类问题下次能被认出来是失败，而不是又躲过一整轮验收。
  /workspace not trusted/i,
  /permissionerror/i
]

function detectSilentError(result, payload) {
  const reply = String(result?.reply || "")
  const toolEvents = Number(result?.tool_events || 0)
  const plannedFiles = Array.isArray(payload?.plannedFiles) ? payload.plannedFiles : []
  const completedFiles = Array.isArray(result?.completed_files) ? result.completed_files : []
  const remainingFiles = Array.isArray(result?.remaining_files) ? result.remaining_files : []

  // Guard: tasks without plannedFiles (review/analysis) skip all detection
  // Guard: [TASK_COMPLETE] marker present — trust the agent's self-report
  if (reply.toLowerCase().includes("[task_complete]")) return { hasError: false, errorMessage: "" }

  // Guard: has tool activity and substantial reply — likely real work done
  if (toolEvents > 0 && reply.length >= 200) return { hasError: false, errorMessage: "" }

  // Pattern matching: known provider error signatures in reply.
  // 0.5.2 之前这里对 plannedFiles 为空的任务整体短路 —— 兜底计划的任务恰好
  // 都没有 plannedFiles，一句 "provider error: authentication failed (403)"
  // 的回复被原样记成 completed（既没工具活动也没产物），真实验收里因此
  // 出现「秒完成、零产物」的空转轮次。错误签名与文件无关，先查。
  for (const pattern of SILENT_ERROR_PATTERNS) {
    if (pattern.test(reply)) {
      return { hasError: true, errorMessage: `silent provider error detected: ${reply.slice(0, 200)}` }
    }
  }

  // 文件类启发式只对声明了 plannedFiles 的任务有意义
  if (plannedFiles.length === 0) return { hasError: false, errorMessage: "" }

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
      interruptionReason: INTERRUPTION_REASONS.USER_CANCEL,
      endedAt: now()
    }))
    process.exitCode = 0
    return
  }

  await patchTask(taskId, () => ({
    status: "running",
    workerPid: process.pid,
    startedAt: now(),
    lastHeartbeatAt: now()
  }))

  const abortController = new AbortController()
  const parentPid = process.ppid
  let stopping = false
  let runtimeSettled = false
  const pendingRuntimeWrites = new Set()
  const trackRuntimeWrite = (promise) => {
    pendingRuntimeWrites.add(promise)
    promise.finally(() => pendingRuntimeWrites.delete(promise)).catch(() => {})
  }
  const heartbeatTimer = setInterval(() => {
    if (stopping) return
    trackRuntimeWrite(patchTask(taskId, () => ({ lastHeartbeatAt: now() })))
  }, 2000)

  const cancelPoll = setInterval(() => {
    if (stopping) return
    // Orphan detection: if parent process died, self-terminate
    try { process.kill(parentPid, 0) } catch {
      if (!abortController.signal.aborted) {
        abortController.abort(makeAbortError("parent process exited, worker orphaned"))
      }
      return
    }
    trackRuntimeWrite(readTask(taskId).then((latest) => {
      if (latest?.cancelled && !abortController.signal.aborted) {
        abortController.abort(makeAbortError("cancelled by user"))
      }
    }))
  }, 1500)

  const timeoutMs = Math.max(1000, Number(task.payload?.workerTimeoutMs || 900000))
  const timeoutTimer = setTimeout(() => {
    if (!abortController.signal.aborted) {
      abortController.abort(makeAbortError(`worker timeout after ${timeoutMs}ms`))
    }
  }, timeoutMs)

  const settleRuntime = async () => {
    if (!runtimeSettled) {
      runtimeSettled = true
      stopping = true
      clearInterval(heartbeatTimer)
      clearInterval(cancelPoll)
      clearTimeout(timeoutTimer)
      await Promise.allSettled([...pendingRuntimeWrites])
    }
    if (_logFlushTimer) {
      clearTimeout(_logFlushTimer)
      _logFlushTimer = null
    }
    if (_logFlushPromise) {
      await _logFlushPromise
    }
    await flushLogBuffer(taskId).catch(() => {})
  }

  try {
    await appendTaskLog(taskId, `task started (worker pid=${process.pid})`)

    const latest = await readTask(taskId)
    if (!latest?.payload?.workerType || latest.payload.workerType !== "delegate_task") {
      throw new Error(`unsupported workerType: ${latest?.payload?.workerType || "unknown"}`)
    }

    const result = await runDelegateTask(latest, abortController.signal)
    const silentCheck = detectSilentError(result, latest.payload)
    if (silentCheck.hasError) {
      await appendTaskLog(taskId, `silent error detected: ${silentCheck.errorMessage}`)
      await settleRuntime()
      await patchTask(taskId, () => ({
        status: "error",
        result,
        error: silentCheck.errorMessage,
        endedAt: now(),
        lastHeartbeatAt: now()
      }))
      process.exitCode = 1
      return
    } else {
      await appendTaskLog(taskId, "task completed")
      await settleRuntime()
      await patchTask(taskId, () => ({
        status: "completed",
        result,
        error: null,
        endedAt: now(),
        lastHeartbeatAt: now()
      }))
      process.exitCode = 0
      return
    }
  } catch (error) {
    const latest = await readTask(taskId)
    const cancelled = latest?.cancelled
    const aborted = isAbortError(error)
    if (cancelled) {
      await appendTaskLog(taskId, "task cancelled")
      await settleRuntime()
      await patchTask(taskId, () => ({
        status: "cancelled",
        interruptionReason: INTERRUPTION_REASONS.USER_CANCEL,
        endedAt: now(),
        error: null
      }))
      process.exitCode = 0
      return
    }

    if (aborted) {
      await appendTaskLog(taskId, `task interrupted: ${error.message}`)
      await settleRuntime()
      await patchTask(taskId, () => ({
        status: "interrupted",
        interruptionReason: normalizeInterruptionReason(error.message),
        error: error.message,
        endedAt: now()
      }))
      process.exitCode = 2
      return
    }

    await appendTaskLog(taskId, `task error: ${error.message}`)
    await settleRuntime()
    await patchTask(taskId, () => ({
      status: "error",
      error: error.message,
      endedAt: now()
    }))
    process.exitCode = 1
  } finally {
    await settleRuntime()
  }
}

main().catch(() => {
  process.exitCode = 1
}).finally(() => { if (process.connected) process.disconnect() })
