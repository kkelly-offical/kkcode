import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { paint } from "../theme/color.mjs"

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07)/g
function stripAnsi(text) { return String(text || "").replace(ANSI_RE, "") }

let _theme = null
function diffAdd(theme) { return (theme ?? _theme)?.components?.diff_add || "green" }
function diffDel(theme) { return (theme ?? _theme)?.components?.diff_del || "red" }

// ── Symbols ──────────────────────────────────────────────
export const SYM = {
  dot: "●",
  dotHollow: "○",
  toolOk: "✓",
  toolErr: "✗",
  stage: "◆",
  iteration: "↻",
  phase: "●",
  plan: "☐",
  planDone: "☑",
  recovery: "⟳",
  alert: "!",
  thinking: "▶",
  thinkingOpen: "▼",
  search: "*",
  arrow: "→",
  write: "◇"
}

// ── Helpers ──────────────────────────────────────────────

function clipText(text, max) {
  const s = String(text || "").trim()
  if (s.length <= max) return s
  return s.slice(0, max - 3) + "..."
}

function shortPath(p) {
  const s = String(p || "").trim()
  // Show last 2-3 segments for readability
  const parts = s.replace(/\\/g, "/").split("/")
  if (parts.length <= 3) return s
  return ".../" + parts.slice(-3).join("/")
}

// ── Tool Display Formatters ──────────────────────────────

export function formatToolStart(toolName, args) {
  // Compact single-line dim format (OpenCode style)
  const sym = toolName === "grep" || toolName === "glob" || toolName === "websearch"
    ? SYM.search
    : toolName === "write" || toolName === "edit" || toolName === "notebookedit"
      ? SYM.write
      : SYM.arrow
  const prefix = paint(sym, "#666666")
  const name = paint(toolName.charAt(0).toUpperCase() + toolName.slice(1), null, { dim: true })

  switch (toolName) {
    case "bash": {
      const desc = clipText(args?.description || args?.command, 80)
      return `  ${prefix} ${name} ${paint(desc, null, { dim: true })}`
    }
    case "write":
    case "edit":
      return `  ${prefix} ${name} ${paint(shortPath(args?.path), null, { dim: true })}`
    case "notebookedit":
      return `  ${prefix} ${name} ${paint(shortPath(args?.path), null, { dim: true })} ${paint(`cell ${args?.cell_number ?? 0}`, null, { dim: true })}`
    case "read":
    case "list":
      return `  ${prefix} ${name} ${paint(shortPath(args?.path || "."), null, { dim: true })}`
    case "grep":
    case "glob":
      return `  ${prefix} ${name} ${paint(clipText(args?.pattern, 60), null, { dim: true })}`
    case "task":
      return `  ${prefix} ${name} ${paint(clipText(args?.description || args?.prompt, 60), null, { dim: true })}`
    case "todowrite":
      return null // handled by result preview only
    case "webfetch":
      return `  ${prefix} ${name} ${paint(clipText(args?.url, 60), null, { dim: true })}`
    case "websearch":
      return `  ${prefix} ${name} ${paint(clipText(args?.query, 60), null, { dim: true })}`
    case "question":
      return `  ~ ${paint("Asking questions...", null, { dim: true })}`
    case "enter_plan":
      return `  ${paint(SYM.plan, "magenta")} ${paint("Enter Plan", "magenta")}`
    case "exit_plan":
      return `  ${paint(SYM.planDone, "green")} ${paint("Submit Plan", "green")}`
    default:
      return `  ${prefix} ${name} ${paint(clipText(args ? Object.keys(args).slice(0, 3).join(", ") : "", 40), null, { dim: true })}`
  }
}

export function formatToolFinish(toolName, status, durationMs, args) {
  if (status === "error") {
    return `  ${paint(SYM.toolErr, "red")} ${paint(toolName, null, { dim: true })} ${paint("error", "red")}${durationMs ? paint(` ${durationMs}ms`, null, { dim: true }) : ""}`
  }
  // For completed tools, return null — the start line + result preview is enough
  return null
}

export function formatToolResultPreview(toolName, output, status, args) {
  if (status !== "completed") return null
  const text = String(output || "").trim()

  switch (toolName) {
    case "bash": {
      const lines = stripAnsi(text).split("\n").filter(Boolean)
      if (!lines.length) return null
      const first = clipText(lines[0], 90)
      const suffix = lines.length > 1 ? paint(` (+${lines.length - 1} lines)`, null, { dim: true }) : ""
      return `    ${paint(first, null, { dim: true })}${suffix}`
    }
    case "write": {
      const n = String(args?.content || "").split("\n").filter(Boolean).length
      return `    ${paint(`+${n} lines`, diffAdd(), { dim: true })}`
    }
    case "edit": {
      const added = String(args?.new_string || "").split("\n").filter(Boolean).length
      const removed = String(args?.old_string || "").split("\n").filter(Boolean).length
      const parts = []
      if (added > 0) parts.push(paint(`+${added}`, diffAdd()))
      if (removed > 0) parts.push(paint(`-${removed}`, diffDel()))
      return parts.length ? `    ${parts.join(" ")} ${paint("lines", null, { dim: true })}` : null
    }
    case "grep": {
      const lines = text.split("\n").filter(Boolean)
      if (text === "no matches" || !lines.length) return `    ${paint("no matches", null, { dim: true })}`
      return `    ${paint(`${lines.length} matches`, null, { dim: true })}`
    }
    case "read":
      return `    ${paint(`${text.split("\n").length} lines`, null, { dim: true })}`
    case "glob": {
      const lines = text.split("\n").filter(Boolean)
      if (!lines.length) return `    ${paint("no files", null, { dim: true })}`
      return `    ${paint(`${lines.length} files`, null, { dim: true })}`
    }
    case "todowrite": {
      const todos = Array.isArray(args?.todos) ? args.todos : []
      if (!todos.length) return null
      const result = []
      for (const t of todos.slice(0, 8)) {
        const s = t.status || "pending"
        const dot = s === "completed" ? paint(SYM.toolOk, "green")
          : s === "in_progress" ? paint(SYM.dot, "yellow")
          : paint(SYM.dotHollow, "#666666")
        const color = s === "completed" ? "green" : s === "in_progress" ? "yellow" : null
        const label = s === "in_progress" && t.activeForm ? t.activeForm : t.content
        result.push(`  ${dot} ${paint(label || "", color, { dim: s === "completed" })}`)
      }
      if (todos.length > 8) result.push(paint(`  ... +${todos.length - 8} more`, null, { dim: true }))
      return result
    }
    default:
      return null
  }
}

function formatToolError(error) {
  if (!error) return null
  return `  ${paint(clipText(stripAnsi(error), 120), "red", { dim: true })}`
}

// ── Thinking Formatter ──────────────────────────────────

export function formatThinkingHeader() {
  return `${paint(SYM.dot, "#666666")} ${paint("Thinking", null, { italic: true, dim: true })} ${paint("∨", null, { dim: true })}`
}

// ── LongAgent Display Formatters ─────────────────────────

export function formatPhaseChange(prevPhase, nextPhase, reason) {
  const arrow = paint("→", null, { dim: true })
  const reasonText = reason ? paint(reason, null, { dim: true }) : ""
  return `${paint(SYM.phase, "magenta")} ${paint("phase", "magenta", { bold: true })} ${paint(prevPhase, null, { dim: true })} ${arrow} ${paint(nextPhase, "magenta", { bold: true })} ${reasonText}`
}

export function formatStageStarted(stageId, taskCount) {
  return `${paint(SYM.stage, "#fb923c", { bold: true })} ${paint("stage", "#fb923c", { bold: true })} ${paint(stageId, "white", { bold: true })} ${paint(`(${taskCount} tasks)`, null, { dim: true })}`
}

export function formatStageFinished(stageId, successCount, failCount) {
  const status = failCount === 0
    ? paint("PASS", "green", { bold: true })
    : paint(`FAIL (${failCount})`, "red", { bold: true })
  return `${paint(SYM.stage, "#fb923c")} ${paint("stage", "#fb923c")} ${paint(stageId, "white")} ${status} ${paint(`(${successCount} ok)`, null, { dim: true })}`
}

export function formatTaskDispatched(_stageId, taskId, attempt) {
  const attemptLabel = attempt > 1 ? paint(` retry#${attempt}`, "yellow") : ""
  return `   ${paint(SYM.dot, "#666666")} ${paint("task", "cyan")} ${paint(taskId, null, { dim: true })}${attemptLabel}`
}

export function formatTaskFinished(taskId, status) {
  const dot = status === "completed" ? paint(SYM.dot, "green") : paint(SYM.dot, "red")
  const color = status === "completed" ? "green" : "red"
  return `   ${dot} ${paint(taskId, null, { dim: true })} ${paint(status, color)}`
}

export function formatHeartbeat(iteration, maxIterations, phase, gate, progress, elapsed) {
  const iterLabel = maxIterations > 0 ? `${iteration}/${maxIterations}` : String(iteration)
  const progressLabel = progress?.percentage !== null && progress?.percentage !== undefined
    ? paint(`${progress.percentage}%`, "green")
    : paint("...", null, { dim: true })
  const elapsedLabel = elapsed !== undefined ? paint(`${elapsed}s`, null, { dim: true }) : ""
  return `${paint(SYM.iteration, "#fb923c")} ${paint("iter", "#fb923c")} ${paint(iterLabel, "white", { bold: true })} phase=${paint(phase || "-", "magenta")} gate=${paint(gate || "-", "cyan")} progress=${progressLabel} ${elapsedLabel}`
}

export function formatPlanFrozen(planId, stageCount) {
  return `${paint(SYM.planDone, "green", { bold: true })} ${paint("plan frozen", "green", { bold: true })} ${paint(planId || "", null, { dim: true })} ${paint(`${stageCount} stage(s)`, null, { dim: true })}`
}

export function formatRecovery(reason, recoveryCount) {
  return `${paint(SYM.recovery, "yellow", { bold: true })} ${paint("recovery", "yellow", { bold: true })} #${recoveryCount} ${paint(reason || "", null, { dim: true })}`
}

export function formatAlert(kind, message) {
  return `${paint(SYM.alert, "red", { bold: true })} ${paint("alert", "red", { bold: true })} [${kind}] ${paint(message || "", null, { dim: true })}`
}

export function formatIntakeStarted(objective) {
  const preview = clipText(objective, 80)
  return `${paint(SYM.phase, "magenta")} ${paint("intake", "magenta", { bold: true })} ${paint(preview, null, { dim: true })}`
}

export function formatGateChecked(gate, status) {
  const dot = status === "pass" ? paint(SYM.dot, "green") : paint(SYM.dot, "yellow")
  return `   ${dot} gate=${paint(gate || "-", "cyan")} ${paint(status || "-", status === "pass" ? "green" : "yellow")}`
}

// ── Hybrid Stage Formatters ──────────────────────────────

function hybridBanner(label, color) {
  const line = paint("━".repeat(40), color, { dim: true })
  return `${line}\n${paint(label, color, { bold: true })}`
}

export function formatHybridPreviewStart(objective) {
  const preview = clipText(objective, 70)
  return `${hybridBanner("H1 Preview", "#3b82f6")}\n  ${paint(preview, null, { dim: true })}`
}

export function formatHybridPreviewComplete(findingsLength) {
  return `  ${paint(SYM.toolOk, "green")} ${paint("preview complete", "green")} ${paint(`(${findingsLength} chars)`, null, { dim: true })}`
}

export function formatHybridBlueprintStart() {
  return hybridBanner("H2 Blueprint", "#a855f7")
}

export function formatHybridBlueprintComplete(planId, stageCount) {
  return `  ${paint(SYM.toolOk, "green")} ${paint("blueprint complete", "green")} ${paint(planId || "", null, { dim: true })} ${paint(`${stageCount} stage(s)`, null, { dim: true })}`
}

export function formatHybridBlueprintReview(planId) {
  return `  ${paint("⏳", "yellow")} ${paint("awaiting blueprint review", "yellow")} ${paint(planId || "", null, { dim: true })}`
}

export function formatHybridBlueprintValidated(totalTasks, totalFiles, valid) {
  const status = valid ? paint("PASS", "green") : paint("WARN", "yellow")
  return `  ${paint(SYM.dot, valid ? "green" : "yellow")} ${paint("blueprint validation", null, { dim: true })} ${status} ${paint(`${totalTasks} tasks, ${totalFiles} files`, null, { dim: true })}`
}

// ── Hybrid Debugging/Rollback Formatters ─────────────────

export function formatHybridDebuggingStart(codingRollbackCount) {
  const suffix = codingRollbackCount > 0 ? ` ${paint(`(rollback #${codingRollbackCount})`, "yellow")}` : ""
  return `${hybridBanner("H5 Debugging", "#fb923c")}${suffix}`
}

export function formatHybridDebuggingComplete(debugIter, rollback) {
  const status = rollback
    ? paint("ROLLBACK", "yellow", { bold: true })
    : paint("PASS", "green", { bold: true })
  return `  ${paint(SYM.dot, rollback ? "yellow" : "green")} ${paint("debugging", null, { dim: true })} ${status} ${paint(`(${debugIter} iters)`, null, { dim: true })}`
}

export function formatHybridReturnToCoding(rollbackCount, failedTaskIds) {
  const tasks = failedTaskIds?.length ? paint(` [${failedTaskIds.join(", ")}]`, null, { dim: true }) : ""
  return `  ${paint(SYM.recovery, "yellow")} ${paint(`rollback to coding #${rollbackCount}`, "yellow")}${tasks}`
}

export function formatHybridCrossReview(fileCount) {
  return `  ${paint(SYM.dot, "cyan")} ${paint("cross-review", "cyan")} ${paint(`${fileCount} file(s)`, null, { dim: true })}`
}

// ── Hybrid Incremental/Budget/Context Formatters ─────────

export function formatHybridIncrementalGate(stageId, passed) {
  const dot = passed ? paint(SYM.dot, "green") : paint(SYM.dot, "yellow")
  const status = passed ? paint("pass", "green") : paint("warn", "yellow")
  return `   ${dot} ${paint("gate", null, { dim: true })} ${paint(stageId, "cyan")} ${status}`
}

export function formatHybridContextCompressed(newLength) {
  return `  ${paint(SYM.dot, "#666666")} ${paint(`context compressed → ${newLength} chars`, null, { dim: true })}`
}

export function formatHybridBudgetWarning(totalTokens, budgetLimit, percentage) {
  const color = percentage >= 100 ? "red" : "yellow"
  return `  ${paint(SYM.alert, color)} ${paint("budget", color, { bold: true })} ${paint(`${percentage}%`, color)} ${paint(`(${totalTokens}/${budgetLimit})`, null, { dim: true })}`
}

export function formatHybridCheckpointResumed(stageIndex, iteration) {
  return `  ${paint(SYM.dot, "cyan")} ${paint("checkpoint resumed", "cyan")} ${paint(`stage ${stageIndex}, iter ${iteration}`, null, { dim: true })}`
}

export function formatHybridReplan(newStageCount) {
  return `  ${paint(SYM.dot, "#a855f7")} ${paint("replan", "#a855f7", { bold: true })} ${paint(`→ ${newStageCount} stage(s)`, null, { dim: true })}`
}

// ── Hybrid Memory Formatters ─────────────────────────────

export function formatHybridMemoryLoaded(techStack) {
  const items = Array.isArray(techStack) ? techStack.slice(0, 5).join(", ") : ""
  return `  ${paint(SYM.dot, "#666666")} ${paint("memory loaded", null, { dim: true })} ${paint(items, null, { dim: true })}`
}

export function formatHybridMemorySaved(techStackCount) {
  return `  ${paint(SYM.dot, "#666666")} ${paint(`memory saved (${techStackCount} items)`, null, { dim: true })}`
}

// ── Git Formatters ───────────────────────────────────────

export function formatGitBranchCreated(branch, baseBranch) {
  return `  ${paint(SYM.dot, "green")} ${paint("git branch", "green")} ${paint(branch, "white", { bold: true })} ${paint(`← ${baseBranch}`, null, { dim: true })}`
}

export function formatGitStageCommitted(stageId, message) {
  return `   ${paint(SYM.dot, "#666666")} ${paint("commit", null, { dim: true })} ${paint(clipText(message || stageId, 60), null, { dim: true })}`
}

export function formatGitMerged(branch, baseBranch) {
  return `  ${paint(SYM.toolOk, "green")} ${paint("git merged", "green", { bold: true })} ${paint(branch, null, { dim: true })} ${paint("→", null, { dim: true })} ${paint(baseBranch, "white")}`
}

// ── Plan Progress Formatter ──────────────────────────────

export function formatPlanProgress(taskProgress) {
  if (!taskProgress || typeof taskProgress !== "object") return []
  const entries = Object.entries(taskProgress)
  if (!entries.length) return []

  const lines = [paint("Plan Progress:", "cyan", { bold: true })]
  for (const [taskId, tp] of entries) {
    const status = tp?.status || "pending"
    const dot = status === "completed"
      ? paint(SYM.dot, "green")
      : status === "error"
        ? paint(SYM.dot, "red")
        : paint(SYM.dotHollow, "#666666")
    const color = status === "completed" ? "green" : status === "error" ? "red" : "white"
    lines.push(`  ${dot} ${taskId} ${paint(status, color)}`)
  }
  return lines
}

// ── Recovery Suggestions Formatter ───────────────────────

export function formatRecoverySuggestions(recovery) {
  if (!recovery) return []
  const lines = []
  lines.push(paint("Recovery Suggestions:", "yellow", { bold: true }))

  if (recovery.summary) {
    lines.push(`  ${paint(recovery.summary, null, { dim: true })}`)
  }

  if (recovery.suggestions?.length) {
    for (const s of recovery.suggestions) {
      lines.push(`  ${paint(SYM.alert, "yellow")} ${paint(s, "yellow")}`)
    }
  }

  if (recovery.failedTasks?.length) {
    lines.push(paint("  Failed Tasks:", "red"))
    for (const t of recovery.failedTasks.slice(0, 5)) {
      lines.push(`    ${paint(SYM.dot, "red")} ${t.taskId} [${t.category}]: ${paint(t.error || "", null, { dim: true })}`)
    }
  }

  if (recovery.manualSteps?.length) {
    lines.push(paint("  Manual Steps:", "cyan"))
    for (const step of recovery.manualSteps.slice(0, 5)) {
      lines.push(`    ${paint(SYM.arrow, "cyan")} ${paint(step, null, { dim: true })}`)
    }
  }

  if (recovery.resumeHint) {
    lines.push(`  ${paint(SYM.dot, "green")} ${paint(recovery.resumeHint, "green")}`)
  }

  return lines
}

// ── Renderer ─────────────────────────────────────────────

export function createActivityRenderer({ output, theme = null }) {
  _theme = theme
  const log = typeof output?.appendLog === "function"
    ? output.appendLog
    : (text) => console.log(text)

  const toolTimers = new Map()
  let timerCounter = 0
  let unsubscribe = null

  function timerKey(sessionId, turnId, toolName) {
    return `${sessionId || ""}:${turnId || ""}:${toolName}:${timerCounter++}`
  }

  // Track the latest timer key per tool invocation
  const activeToolKeys = new Map()
  // Track tool args for finish formatting
  const activeToolArgs = new Map()

  function handleEvent(event) {
    const { type, payload, sessionId, turnId } = event

    switch (type) {
      case EVENT_TYPES.TOOL_START: {
        const key = timerKey(sessionId, turnId, payload.tool)
        const lookupKey = `${sessionId}:${turnId}:${payload.tool}`
        toolTimers.set(key, Date.now())
        activeToolKeys.set(lookupKey, key)
        activeToolArgs.set(lookupKey, payload.args)
        // Show tool call inline (compact dim line)
        const startLine = formatToolStart(payload.tool, payload.args)
        if (startLine) log(startLine)
        break
      }

      case EVENT_TYPES.TOOL_FINISH: {
        const lookupKey = `${sessionId}:${turnId}:${payload.tool}`
        const key = activeToolKeys.get(lookupKey)
        const savedArgs = activeToolArgs.get(lookupKey) || payload.args
        if (key) {
          toolTimers.delete(key)
          activeToolKeys.delete(lookupKey)
          activeToolArgs.delete(lookupKey)
        }
        const finishLine = formatToolFinish(payload.tool, payload.status, 0, savedArgs)
        if (finishLine) log(finishLine)
        const preview = formatToolResultPreview(payload.tool, payload.output, payload.status, savedArgs)
        if (preview) {
          if (Array.isArray(preview)) {
            for (const line of preview) log(line)
          } else {
            log(preview)
          }
        }
        // Blank line after tool for visual spacing
        if (payload.tool !== "todowrite") log("")
        break
      }

      case EVENT_TYPES.TOOL_ERROR: {
        const lookupKey = `${sessionId}:${turnId}:${payload.tool}`
        const key = activeToolKeys.get(lookupKey)
        const savedArgs = activeToolArgs.get(lookupKey) || payload.args
        if (key) {
          toolTimers.delete(key)
          activeToolKeys.delete(lookupKey)
          activeToolArgs.delete(lookupKey)
        }
        log(formatToolFinish(payload.tool, payload.status || "error", 0, savedArgs))
        const errLine = formatToolError(payload.error)
        if (errLine) log(errLine)
        break
      }

      case EVENT_TYPES.LONGAGENT_PHASE_CHANGED: {
        log(formatPhaseChange(payload.prevPhase, payload.nextPhase, payload.reason))
        break
      }

      case EVENT_TYPES.LONGAGENT_STAGE_STARTED: {
        log(formatStageStarted(payload.stageId, payload.taskCount))
        break
      }

      case EVENT_TYPES.LONGAGENT_STAGE_FINISHED: {
        log(formatStageFinished(payload.stageId, payload.successCount, payload.failCount))
        break
      }

      case EVENT_TYPES.LONGAGENT_STAGE_TASK_DISPATCHED: {
        log(formatTaskDispatched(payload.stageId, payload.taskId, payload.attempt))
        break
      }

      case EVENT_TYPES.LONGAGENT_STAGE_TASK_FINISHED: {
        log(formatTaskFinished(payload.taskId, payload.status))
        break
      }

      case EVENT_TYPES.LONGAGENT_HEARTBEAT: {
        log(formatHeartbeat(
          payload.iteration,
          payload.maxIterations,
          payload.phase,
          payload.gate,
          payload.progress,
          payload.elapsed
        ))
        break
      }

      case EVENT_TYPES.LONGAGENT_PLAN_FROZEN: {
        log(formatPlanFrozen(payload.planId, payload.stageCount))
        break
      }

      case EVENT_TYPES.LONGAGENT_RECOVERY_ENTERED: {
        log(formatRecovery(payload.reason, payload.recoveryCount))
        break
      }

      case EVENT_TYPES.LONGAGENT_ALERT: {
        log(formatAlert(payload.kind, payload.message))
        break
      }

      case EVENT_TYPES.LONGAGENT_INTAKE_STARTED: {
        log(formatIntakeStarted(payload.objective))
        break
      }

      case EVENT_TYPES.LONGAGENT_GATE_CHECKED: {
        log(formatGateChecked(payload.gate, payload.status))
        break
      }

      // ── Hybrid Events ──────────────────────────────
      case EVENT_TYPES.LONGAGENT_HYBRID_PREVIEW_START: {
        log(formatHybridPreviewStart(payload.objective))
        break
      }
      case EVENT_TYPES.LONGAGENT_HYBRID_PREVIEW_COMPLETE: {
        log(formatHybridPreviewComplete(payload.findingsLength))
        break
      }
      case EVENT_TYPES.LONGAGENT_HYBRID_BLUEPRINT_START: {
        log(formatHybridBlueprintStart())
        break
      }
      case EVENT_TYPES.LONGAGENT_HYBRID_BLUEPRINT_COMPLETE: {
        log(formatHybridBlueprintComplete(payload.planId, payload.stageCount))
        break
      }
      case EVENT_TYPES.LONGAGENT_HYBRID_BLUEPRINT_REVIEW: {
        log(formatHybridBlueprintReview(payload.planId))
        break
      }
      case EVENT_TYPES.LONGAGENT_HYBRID_BLUEPRINT_VALIDATED: {
        log(formatHybridBlueprintValidated(payload.totalTasks, payload.totalFiles, payload.valid))
        break
      }
      case EVENT_TYPES.LONGAGENT_HYBRID_DEBUGGING_START: {
        log(formatHybridDebuggingStart(payload.codingRollbackCount))
        break
      }
      case EVENT_TYPES.LONGAGENT_HYBRID_DEBUGGING_COMPLETE: {
        log(formatHybridDebuggingComplete(payload.debugIter, payload.rollback))
        break
      }
      case EVENT_TYPES.LONGAGENT_HYBRID_RETURN_TO_CODING: {
        log(formatHybridReturnToCoding(payload.rollbackCount, payload.failedTaskIds))
        break
      }
      case EVENT_TYPES.LONGAGENT_HYBRID_CROSS_REVIEW: {
        log(formatHybridCrossReview(payload.fileCount))
        break
      }
      case EVENT_TYPES.LONGAGENT_HYBRID_INCREMENTAL_GATE: {
        log(formatHybridIncrementalGate(payload.stageId, payload.passed))
        break
      }
      case EVENT_TYPES.LONGAGENT_HYBRID_CONTEXT_COMPRESSED: {
        log(formatHybridContextCompressed(payload.newLength))
        break
      }
      case EVENT_TYPES.LONGAGENT_HYBRID_BUDGET_WARNING: {
        log(formatHybridBudgetWarning(payload.totalTokens, payload.budgetLimit, payload.percentage))
        break
      }
      case EVENT_TYPES.LONGAGENT_HYBRID_CHECKPOINT_RESUMED: {
        log(formatHybridCheckpointResumed(payload.stageIndex, payload.iteration))
        break
      }
      case EVENT_TYPES.LONGAGENT_HYBRID_REPLAN: {
        log(formatHybridReplan(payload.newStageCount))
        break
      }
      case EVENT_TYPES.LONGAGENT_HYBRID_MEMORY_LOADED: {
        log(formatHybridMemoryLoaded(payload.techStack))
        break
      }
      case EVENT_TYPES.LONGAGENT_HYBRID_MEMORY_SAVED: {
        log(formatHybridMemorySaved(payload.techStackCount))
        break
      }

      // ── New Fault Recovery Events ──────────────────
      case EVENT_TYPES.LONGAGENT_DEGRADATION_APPLIED: {
        log(formatAlert("degradation", `${payload.strategy} applied in ${payload.phase}${payload.reason ? ` (${payload.reason})` : ""}`))
        break
      }
      case EVENT_TYPES.LONGAGENT_WRITE_LOOP_DETECTED: {
        log(formatAlert("write_loop", payload.message || "write loop detected"))
        break
      }
      case EVENT_TYPES.LONGAGENT_SEMANTIC_ERROR_REPEATED: {
        log(formatAlert("semantic_error", `repeated ${payload.count}x: ${(payload.error || "").slice(0, 80)}`))
        break
      }
      case EVENT_TYPES.LONGAGENT_PHASE_TIMEOUT: {
        log(formatAlert("phase_timeout", `${payload.phase} timed out after ${Math.round((payload.elapsed || 0) / 1000)}s`))
        break
      }
      case EVENT_TYPES.LONGAGENT_GIT_CONFLICT_RESOLUTION: {
        log(formatAlert("git_conflict", `resolving conflicts in ${(payload.files || []).length} file(s)`))
        break
      }
      case EVENT_TYPES.LONGAGENT_CHECKPOINT_CLEANED: {
        log(`  ${paint(SYM.dot, "#666666")} ${paint(`checkpoints cleaned (${payload.removed} removed)`, null, { dim: true })}`)
        break
      }

      // ── Git Events ─────────────────────────────────
      case EVENT_TYPES.LONGAGENT_GIT_BRANCH_CREATED: {
        log(formatGitBranchCreated(payload.branch, payload.baseBranch))
        break
      }
      case EVENT_TYPES.LONGAGENT_GIT_STAGE_COMMITTED: {
        log(formatGitStageCommitted(payload.stageId, payload.message))
        break
      }
      case EVENT_TYPES.LONGAGENT_GIT_MERGED: {
        log(formatGitMerged(payload.branch, payload.baseBranch))
        break
      }

      case EVENT_TYPES.SESSION_COMPACTED: {
        log(`${paint(SYM.phase, "magenta")} ${paint("context compacted", "magenta", { dim: true })}`)
        break
      }
    }
  }

  return {
    start() {
      if (unsubscribe) return
      unsubscribe = EventBus.subscribe(handleEvent)
    },
    stop() {
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
      toolTimers.clear()
      activeToolKeys.clear()
      activeToolArgs.clear()
    }
  }
}
