import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { paint } from "../theme/color.mjs"

// ── Symbols ──────────────────────────────────────────────
export const SYM = {
  toolStart: "▶",
  toolOk: "✓",
  toolErr: "✗",
  result: "└─",
  stage: "◆",
  iteration: "↻",
  phase: "●",
  plan: "☐",
  planDone: "☑",
  recovery: "⟳",
  alert: "!"
}

// ── Tool Display Formatters ──────────────────────────────

function clipText(text, max) {
  const s = String(text || "").trim()
  if (s.length <= max) return s
  return s.slice(0, max - 3) + "..."
}

export function formatToolStart(toolName, args) {
  const label = paint(toolName, "cyan", { bold: true })
  const prefix = paint(SYM.toolStart, "cyan")

  switch (toolName) {
    case "bash": {
      const cmd = clipText(args?.command, 120)
      return `${prefix} ${label} ${paint(cmd, null, { dim: true })}`
    }
    case "write": {
      const filePath = String(args?.path || "").trim()
      return `${prefix} ${label} ${paint(filePath, "green")}`
    }
    case "edit": {
      const filePath = String(args?.path || "").trim()
      return `${prefix} ${label} ${paint(filePath, "yellow")}`
    }
    case "read": {
      const filePath = String(args?.path || "").trim()
      return `${prefix} ${label} ${paint(filePath, null, { dim: true })}`
    }
    case "list": {
      const dirPath = String(args?.path || ".").trim()
      return `${prefix} ${label} ${paint(dirPath, null, { dim: true })}`
    }
    case "grep": {
      const pattern = String(args?.pattern || "").trim()
      return `${prefix} ${label} ${paint(pattern, "magenta")}`
    }
    case "task": {
      const desc = clipText(args?.description || args?.prompt, 80)
      return `${prefix} ${label} ${paint(desc, null, { dim: true })}`
    }
    case "todowrite": {
      const count = Array.isArray(args?.todos) ? args.todos.length : 0
      return `${prefix} ${label} ${paint(`${count} items`, null, { dim: true })}`
    }
    case "webfetch": {
      const url = clipText(args?.url, 80)
      return `${prefix} ${label} ${paint(url, null, { dim: true })}`
    }
    case "question": {
      const q = clipText(args?.question, 80)
      return `${prefix} ${label} ${paint(q, null, { dim: true })}`
    }
    default: {
      const argKeys = args ? Object.keys(args).slice(0, 3).join(", ") : ""
      return `${prefix} ${label} ${paint(argKeys, null, { dim: true })}`
    }
  }
}

export function formatToolFinish(_toolName, status, durationMs) {
  const elapsed = durationMs ? paint(`${durationMs}ms`, null, { dim: true }) : ""
  const connector = paint(SYM.result, null, { dim: true })

  if (status === "completed") {
    return `   ${connector} ${paint(SYM.toolOk, "green")} ${elapsed}`
  }
  if (status === "error") {
    return `   ${connector} ${paint(SYM.toolErr, "red")} ${paint("error", "red")} ${elapsed}`
  }
  return `   ${connector} ${paint(SYM.toolErr, "yellow")} ${paint(status || "unknown", "yellow")} ${elapsed}`
}

export function formatToolResultPreview(toolName, output, status, args) {
  if (status !== "completed") return null
  const text = String(output || "").trim()
  if (!text) return null
  const connector = paint(SYM.result, null, { dim: true })

  switch (toolName) {
    case "bash": {
      const lines = text.split("\n").filter(Boolean)
      if (!lines.length) return null
      // Show up to 3 lines of output for better visibility
      const previewLines = lines.slice(0, 3).map((l) => clipText(l, 100))
      const suffix = lines.length > 3 ? paint(` (+${lines.length - 3} lines)`, null, { dim: true }) : ""
      const result = []
      result.push(`   ${connector} ${paint(previewLines[0], null, { dim: true })}${previewLines.length === 1 ? suffix : ""}`)
      for (let i = 1; i < previewLines.length; i++) {
        result.push(`   ${paint("│", null, { dim: true })}  ${paint(previewLines[i], null, { dim: true })}${i === previewLines.length - 1 ? suffix : ""}`)
      }
      return result
    }
    case "write": {
      const filePath = String(args?.path || "").trim()
      const result = [`   ${connector} ${paint("created", "green")} ${paint(filePath, "green", { dim: true })}`]
      // Show content preview if available
      if (args?.content) {
        const contentLines = String(args.content).split("\n").filter(Boolean)
        const preview = contentLines.slice(0, 3)
        for (const line of preview) {
          result.push(`   ${paint("│", "green", { dim: true })}  ${paint("+ " + clipText(line, 90), "green", { dim: true })}`)
        }
        if (contentLines.length > 3) {
          result.push(`   ${paint("│", "green", { dim: true })}  ${paint(`... +${contentLines.length - 3} more lines`, null, { dim: true })}`)
        }
      }
      return result
    }
    case "edit": {
      const filePath = String(args?.path || "").trim()
      const result = [`   ${connector} ${paint("modified", "yellow")} ${paint(filePath, "yellow", { dim: true })}`]
      // Show old→new preview
      if (args?.old_string && args?.new_string) {
        const oldLines = String(args.old_string).split("\n").slice(0, 2)
        const newLines = String(args.new_string).split("\n").slice(0, 2)
        for (const line of oldLines) {
          result.push(`   ${paint("│", "yellow", { dim: true })}  ${paint("- " + clipText(line, 90), "red", { dim: true })}`)
        }
        if (String(args.old_string).split("\n").length > 2) {
          result.push(`   ${paint("│", "yellow", { dim: true })}  ${paint("  ...", "red", { dim: true })}`)
        }
        for (const line of newLines) {
          result.push(`   ${paint("│", "yellow", { dim: true })}  ${paint("+ " + clipText(line, 90), "green", { dim: true })}`)
        }
        if (String(args.new_string).split("\n").length > 2) {
          result.push(`   ${paint("│", "yellow", { dim: true })}  ${paint("  ...", "green", { dim: true })}`)
        }
      }
      return result
    }
    case "grep": {
      const lines = text.split("\n").filter(Boolean)
      if (text === "no matches" || !lines.length) {
        return `   ${connector} ${paint("no matches", null, { dim: true })}`
      }
      return `   ${connector} ${paint(`${lines.length} matches`, null, { dim: true })}`
    }
    case "read": {
      const lines = text.split("\n")
      return `   ${connector} ${paint(`${lines.length} lines`, null, { dim: true })}`
    }
    case "glob": {
      const lines = text.split("\n").filter(Boolean)
      if (!lines.length) return `   ${connector} ${paint("no files found", null, { dim: true })}`
      const preview = lines.slice(0, 3).map((l) => clipText(l, 80))
      const suffix = lines.length > 3 ? ` (+${lines.length - 3} more)` : ""
      return `   ${connector} ${paint(`${lines.length} files`, null, { dim: true })} ${paint(preview[0] + suffix, null, { dim: true })}`
    }
    case "task": {
      return `   ${connector} ${paint(clipText(text, 120), null, { dim: true })}`
    }
    default:
      return null
  }
}

function formatToolError(error) {
  if (!error) return null
  const connector = paint(SYM.result, null, { dim: true })
  return `   ${connector} ${paint(clipText(error, 120), "red", { dim: true })}`
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
  return `   ${paint(SYM.toolStart, "cyan")} ${paint("task", "cyan")} ${paint(taskId, null, { dim: true })}${attemptLabel}`
}

export function formatTaskFinished(taskId, status) {
  const sym = status === "completed" ? paint(SYM.toolOk, "green") : paint(SYM.toolErr, "red")
  const color = status === "completed" ? "green" : "red"
  return `   ${paint(SYM.result, null, { dim: true })} ${sym} ${paint(taskId, null, { dim: true })} ${paint(status, color)}`
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
  const sym = status === "pass" ? paint(SYM.toolOk, "green") : paint(SYM.alert, "yellow")
  return `   ${paint(SYM.result, null, { dim: true })} ${sym} gate=${paint(gate || "-", "cyan")} ${paint(status || "-", status === "pass" ? "green" : "yellow")}`
}

// ── Plan Progress Formatter ──────────────────────────────

export function formatPlanProgress(taskProgress) {
  if (!taskProgress || typeof taskProgress !== "object") return []
  const entries = Object.entries(taskProgress)
  if (!entries.length) return []

  const lines = [paint("Plan Progress:", "cyan", { bold: true })]
  for (const [taskId, tp] of entries) {
    const status = tp?.status || "pending"
    const sym = status === "completed"
      ? paint(SYM.planDone, "green")
      : status === "error"
        ? paint(SYM.toolErr, "red")
        : paint(SYM.plan, "white")
    const color = status === "completed" ? "green" : status === "error" ? "red" : "white"
    lines.push(`  ${sym} ${taskId} ${paint(status, color)}`)
  }
  return lines
}

// ── Renderer ─────────────────────────────────────────────

export function createActivityRenderer({ output }) {
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

  function handleEvent(event) {
    const { type, payload, sessionId, turnId } = event

    switch (type) {
      case EVENT_TYPES.TOOL_START: {
        const key = timerKey(sessionId, turnId, payload.tool)
        toolTimers.set(key, Date.now())
        activeToolKeys.set(`${sessionId}:${turnId}:${payload.tool}`, key)
        log(formatToolStart(payload.tool, payload.args))
        break
      }

      case EVENT_TYPES.TOOL_FINISH: {
        const lookupKey = `${sessionId}:${turnId}:${payload.tool}`
        const key = activeToolKeys.get(lookupKey)
        const startedAt = key ? toolTimers.get(key) : null
        const durationMs = startedAt ? Date.now() - startedAt : (payload.durationMs || 0)
        if (key) {
          toolTimers.delete(key)
          activeToolKeys.delete(lookupKey)
        }
        log(formatToolFinish(payload.tool, payload.status, durationMs))
        const preview = formatToolResultPreview(payload.tool, payload.output, payload.status, payload.args)
        if (preview) {
          if (Array.isArray(preview)) {
            for (const line of preview) log(line)
          } else {
            log(preview)
          }
        }
        break
      }

      case EVENT_TYPES.TOOL_ERROR: {
        const lookupKey = `${sessionId}:${turnId}:${payload.tool}`
        const key = activeToolKeys.get(lookupKey)
        const startedAt = key ? toolTimers.get(key) : null
        const durationMs = startedAt ? Date.now() - startedAt : (payload.durationMs || 0)
        if (key) {
          toolTimers.delete(key)
          activeToolKeys.delete(lookupKey)
        }
        log(formatToolFinish(payload.tool, payload.status || "error", durationMs))
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
    }
  }
}
