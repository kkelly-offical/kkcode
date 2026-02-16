import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { paint } from "../theme/color.mjs"

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
  thinkingOpen: "▼"
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

function countLines(text) {
  if (!text) return 0
  return String(text).split("\n").filter(Boolean).length
}

// ── Tool Display Formatters ──────────────────────────────

export function formatToolStart(toolName, args) {
  const dot = paint(SYM.dot, "#666666")
  const name = paint(toolName.charAt(0).toUpperCase() + toolName.slice(1), "white", { bold: true })

  switch (toolName) {
    case "bash": {
      const cmd = clipText(args?.command, 100)
      return `${dot} ${name} ${paint(cmd, null, { dim: true })}`
    }
    case "write": {
      const filePath = shortPath(args?.path)
      return `${dot} ${name} ${paint(filePath, null, { dim: true })}`
    }
    case "edit": {
      const filePath = shortPath(args?.path)
      return `${dot} ${name} ${paint(filePath, null, { dim: true })}`
    }
    case "read": {
      const filePath = shortPath(args?.path)
      const range = args?.offset && args?.limit
        ? paint(` (lines ${args.offset}-${args.offset + args.limit})`, null, { dim: true })
        : ""
      return `${dot} ${name} ${paint(filePath, null, { dim: true })}${range}`
    }
    case "list": {
      const dirPath = shortPath(args?.path || ".")
      return `${dot} ${name} ${paint(dirPath, null, { dim: true })}`
    }
    case "grep": {
      const pattern = String(args?.pattern || "").trim()
      return `${dot} ${name} ${paint(pattern, "magenta")}`
    }
    case "glob": {
      const pattern = String(args?.pattern || "").trim()
      return `${dot} ${name} ${paint(pattern, "magenta")}`
    }
    case "task": {
      const desc = clipText(args?.description || args?.prompt, 80)
      return `${dot} ${name} ${paint(desc, null, { dim: true })}`
    }
    case "todowrite": {
      const count = Array.isArray(args?.todos) ? args.todos.length : 0
      return `${dot} ${name} ${paint(`${count} items`, null, { dim: true })}`
    }
    case "webfetch": {
      const url = clipText(args?.url, 80)
      return `${dot} ${name} ${paint(url, null, { dim: true })}`
    }
    case "websearch": {
      const q = clipText(args?.query, 80)
      return `${dot} ${name} ${paint(q, null, { dim: true })}`
    }
    case "question": {
      const q = clipText(args?.question, 80)
      return `${dot} ${name} ${paint(q, null, { dim: true })}`
    }
    default: {
      const argKeys = args ? Object.keys(args).slice(0, 3).join(", ") : ""
      return `${dot} ${name} ${paint(argKeys, null, { dim: true })}`
    }
  }
}

export function formatToolFinish(toolName, status, durationMs, args) {
  const elapsed = durationMs ? paint(`${durationMs}ms`, null, { dim: true }) : ""

  if (status === "completed") {
    const dot = paint(SYM.dot, "green")
    const name = paint(toolName.charAt(0).toUpperCase() + toolName.slice(1), "white", { bold: true })

    // Show summary based on tool type
    let summary = ""
    switch (toolName) {
      case "write": {
        const filePath = shortPath(args?.path)
        const lines = countLines(args?.content)
        summary = `${paint(filePath, null, { dim: true })}\n  ${paint(`Created ${lines} lines`, "green", { dim: true })}`
        break
      }
      case "edit": {
        const filePath = shortPath(args?.path)
        const added = countLines(args?.new_string)
        const removed = countLines(args?.old_string)
        const parts = []
        if (added > 0) parts.push(paint(`+${added}`, "green"))
        if (removed > 0) parts.push(paint(`-${removed}`, "red"))
        summary = `${paint(filePath, null, { dim: true })}\n  ${parts.length ? parts.join(" ") + " lines" : ""}`
        break
      }
      case "read": {
        const filePath = shortPath(args?.path)
        const range = args?.offset && args?.limit
          ? ` (lines ${args.offset}-${args.offset + args.limit})`
          : ""
        summary = `${paint(filePath + range, null, { dim: true })}`
        break
      }
      default:
        break
    }

    if (summary) {
      return `${dot} ${name} ${summary} ${elapsed}`
    }
    return `${dot} ${name} ${elapsed}`
  }

  if (status === "error") {
    const dot = paint(SYM.dot, "red")
    const name = paint(toolName.charAt(0).toUpperCase() + toolName.slice(1), "white", { bold: true })
    return `${dot} ${name} ${paint("error", "red")} ${elapsed}`
  }

  const dot = paint(SYM.dot, "yellow")
  const name = paint(toolName.charAt(0).toUpperCase() + toolName.slice(1), "white", { bold: true })
  return `${dot} ${name} ${paint(status || "unknown", "yellow")} ${elapsed}`
}

export function formatToolResultPreview(toolName, output, status, args) {
  if (status !== "completed") return null
  const text = String(output || "").trim()

  switch (toolName) {
    case "bash": {
      const lines = text.split("\n").filter(Boolean)
      if (!lines.length) return null
      const preview = lines.slice(0, 3).map((l) => clipText(l, 100))
      const suffix = lines.length > 3 ? paint(` (+${lines.length - 3} lines)`, null, { dim: true }) : ""
      const result = []
      for (let i = 0; i < preview.length; i++) {
        result.push(`  ${paint(preview[i], null, { dim: true })}${i === preview.length - 1 ? suffix : ""}`)
      }
      return result
    }
    case "write": {
      if (!args?.content) return null
      const contentLines = String(args.content).split("\n").filter(Boolean)
      const preview = contentLines.slice(0, 4)
      const result = []
      for (const line of preview) {
        result.push(`  ${paint("+", "green", { bold: true })} ${paint(clipText(line, 90), "green", { dim: true })}`)
      }
      if (contentLines.length > 4) {
        result.push(`  ${paint(`... +${contentLines.length - 4} more lines`, null, { dim: true })}`)
      }
      return result
    }
    case "edit": {
      if (!args?.old_string && !args?.new_string) return null
      const result = []
      // Show removed lines
      if (args?.old_string) {
        const oldLines = String(args.old_string).split("\n")
        const showOld = oldLines.slice(0, 3)
        for (const line of showOld) {
          result.push(`  ${paint("-", "red", { bold: true })} ${paint(clipText(line, 90), "red", { dim: true })}`)
        }
        if (oldLines.length > 3) {
          result.push(`  ${paint(`  ... -${oldLines.length - 3} more`, "red", { dim: true })}`)
        }
      }
      // Show added lines
      if (args?.new_string) {
        const newLines = String(args.new_string).split("\n")
        const showNew = newLines.slice(0, 3)
        for (const line of showNew) {
          result.push(`  ${paint("+", "green", { bold: true })} ${paint(clipText(line, 90), "green", { dim: true })}`)
        }
        if (newLines.length > 3) {
          result.push(`  ${paint(`  ... +${newLines.length - 3} more`, "green", { dim: true })}`)
        }
      }
      return result
    }
    case "grep": {
      const lines = text.split("\n").filter(Boolean)
      if (text === "no matches" || !lines.length) {
        return `  ${paint("no matches", null, { dim: true })}`
      }
      return `  ${paint(`${lines.length} matches`, null, { dim: true })}`
    }
    case "read": {
      const lines = text.split("\n")
      return `  ${paint(`${lines.length} lines`, null, { dim: true })}`
    }
    case "glob": {
      const lines = text.split("\n").filter(Boolean)
      if (!lines.length) return `  ${paint("no files found", null, { dim: true })}`
      const preview = lines.slice(0, 2).map((l) => shortPath(l))
      const suffix = lines.length > 2 ? ` (+${lines.length - 2} more)` : ""
      return `  ${paint(`${lines.length} files: ${preview.join(", ")}${suffix}`, null, { dim: true })}`
    }
    case "task": {
      return `  ${paint(clipText(text, 120), null, { dim: true })}`
    }
    default:
      return null
  }
}

function formatToolError(error) {
  if (!error) return null
  return `  ${paint(clipText(error, 120), "red", { dim: true })}`
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
  // Track tool args for finish formatting
  const activeToolArgs = new Map()

  function handleEvent(event) {
    const { type, payload, sessionId, turnId } = event

    switch (type) {
      case EVENT_TYPES.TOOL_START: {
        // Only track timing & args — the busy line already shows the active tool.
        // We log nothing here; TOOL_FINISH will show the result.
        const key = timerKey(sessionId, turnId, payload.tool)
        const lookupKey = `${sessionId}:${turnId}:${payload.tool}`
        toolTimers.set(key, Date.now())
        activeToolKeys.set(lookupKey, key)
        activeToolArgs.set(lookupKey, payload.args)
        break
      }

      case EVENT_TYPES.TOOL_FINISH: {
        const lookupKey = `${sessionId}:${turnId}:${payload.tool}`
        const key = activeToolKeys.get(lookupKey)
        const startedAt = key ? toolTimers.get(key) : null
        const durationMs = startedAt ? Date.now() - startedAt : (payload.durationMs || 0)
        const savedArgs = activeToolArgs.get(lookupKey) || payload.args
        if (key) {
          toolTimers.delete(key)
          activeToolKeys.delete(lookupKey)
          activeToolArgs.delete(lookupKey)
        }
        log(formatToolFinish(payload.tool, payload.status, durationMs, savedArgs))
        const preview = formatToolResultPreview(payload.tool, payload.output, payload.status, savedArgs)
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
        const savedArgs = activeToolArgs.get(lookupKey) || payload.args
        if (key) {
          toolTimers.delete(key)
          activeToolKeys.delete(lookupKey)
          activeToolArgs.delete(lookupKey)
        }
        log(formatToolFinish(payload.tool, payload.status || "error", durationMs, savedArgs))
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
      activeToolArgs.clear()
    }
  }
}
