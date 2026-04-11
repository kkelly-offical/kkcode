import { BackgroundManager } from "./background-manager.mjs"
import { resolveSubagent } from "./subagent-router.mjs"
import { flushNow, forkSession, getSession } from "../session/store.mjs"
import { extractEditFeedbackFromToolEvents } from "../observability/edit-diagnostics.mjs"

const SUPPORTED_EXECUTION_MODES = new Set(["fresh_agent", "fork_context"])
const SUPPORTED_ISOLATION_MODES = new Set(["default", "worktree"])

function extractFileChanges(toolEvents = []) {
  return toolEvents
    .flatMap((event) => Array.isArray(event?.metadata?.fileChanges) ? event.metadata.fileChanges : [])
    .map((item) => ({
      path: String(item?.path || "").trim(),
      addedLines: Math.max(0, Number(item?.addedLines || 0)),
      removedLines: Math.max(0, Number(item?.removedLines || 0)),
      stageId: item?.stageId ? String(item.stageId) : "",
      taskId: item?.taskId ? String(item.taskId) : ""
    }))
    .filter((item) => item.path)
}

function normalizeExecutionMode(raw) {
  const mode = String(raw || "fresh_agent").trim().toLowerCase() || "fresh_agent"
  if (!SUPPORTED_EXECUTION_MODES.has(mode)) {
    return { error: `unsupported task.execution_mode: ${raw}` }
  }
  return { mode }
}

function normalizeIsolation(raw) {
  const mode = String(raw || "default").trim().toLowerCase() || "default"
  if (!SUPPORTED_ISOLATION_MODES.has(mode)) {
    return { error: `unsupported task.isolation: ${raw}` }
  }
  return { mode }
}

function normalizeList(input) {
  if (Array.isArray(input)) {
    return input
      .map((item) => String(item || "").trim())
      .filter(Boolean)
  }
  if (typeof input === "string") {
    const value = input.trim()
    return value ? [value] : []
  }
  return []
}

function normalizeWriteScope(input) {
  return String(input || "").trim().toLowerCase()
}

function isReadOnlyWriteScope(input) {
  const scope = normalizeWriteScope(input)
  if (!scope) return false
  return [
    "read-only",
    "readonly",
    "no-mutation",
    "no-mutations",
    "no mutation",
    "no mutations",
    "no-write",
    "no-writes",
    "no write",
    "no writes"
  ].includes(scope) || scope.includes("read-only") || scope.includes("no mutation") || scope.includes("no write")
}

function validateDelegationArgs(args = {}, executionMode) {
  const explicitPrompt = String(args.prompt || "").trim()
  const objective = String(args.objective || "").trim()
  const writeScope = String(args.write_scope || "").trim()
  const deliverable = String(args.deliverable || "").trim()
  const isContinuation = Boolean(args.session_id)
  const hasStructuredContinuationFields =
    objective
    || String(args.why || "").trim()
    || writeScope
    || deliverable
    || normalizeList(args.starting_points).length
    || normalizeList(args.constraints).length
    || normalizeList(args.planned_files).length

  if (!explicitPrompt && !objective && !isContinuation) {
    return "task.prompt or task.objective is required when session_id is not provided"
  }
  if (isContinuation && hasStructuredContinuationFields) {
    return "task.session_id cannot be combined with structured brief fields; use a short continuation prompt instead"
  }
  if (isContinuation && !explicitPrompt) {
    return "task.prompt is required when continuing an existing delegated session"
  }
  if (isContinuation && args.execution_mode) {
    return "task.execution_mode only applies when starting a new delegated session"
  }
  if (!explicitPrompt && objective && !writeScope) {
    return "task.write_scope is required when synthesizing a new delegation brief"
  }
  if (!explicitPrompt && objective && !deliverable) {
    return "task.deliverable is required when synthesizing a new delegation brief"
  }
  if (executionMode === "fork_context" && !isReadOnlyWriteScope(writeScope) && !isContinuation) {
    return "task.execution_mode=fork_context is reserved for read-only sidecar work; use fresh_agent for implementation"
  }
  if (args.run_in_background && args.allow_question === true) {
    return "task.run_in_background does not support allow_question=true"
  }
  const isolation = String(args.isolation || "default").trim().toLowerCase() || "default"
  if (isolation === "worktree" && executionMode !== "fresh_agent") {
    return "task.isolation=worktree currently requires execution_mode='fresh_agent'"
  }
  if (isolation === "worktree" && args.run_in_background !== true) {
    return "task.isolation=worktree currently requires run_in_background=true"
  }
  return null
}

function buildDelegationPrompt(args = {}) {
  const explicitPrompt = String(args.prompt || "").trim()
  if (explicitPrompt) return explicitPrompt

  const objective = String(args.objective || "").trim()
  if (!objective) return ""
  const executionMode = String(args.execution_mode || "fresh_agent").trim().toLowerCase() || "fresh_agent"
  const isolation = String(args.isolation || "default").trim().toLowerCase() || "default"

  const why = String(args.why || "").trim()
  const writeScope = String(args.write_scope || "").trim()
  const startingPoints = normalizeList(args.starting_points)
  const constraints = normalizeList(args.constraints)
  const deliverable = String(args.deliverable || "").trim()
  const plannedFiles = normalizeList(args.planned_files)

  const lines = [`Objective: ${objective}`]
  if (why) lines.push(`Why: ${why}`)
  if (writeScope) lines.push(`Write scope: ${writeScope}`)
  if (startingPoints.length) {
    lines.push("Starting points:")
    for (const item of startingPoints) lines.push(`- ${item}`)
  }
  if (constraints.length) {
    lines.push("Constraints:")
    for (const item of constraints) lines.push(`- ${item}`)
  }
  if (plannedFiles.length) {
    lines.push("Planned files:")
    for (const item of plannedFiles) lines.push(`- ${item}`)
  }
  if (deliverable) lines.push(`Deliverable: ${deliverable}`)

  lines.push("Execution contract:")
  lines.push("- Stay local instead of delegating if a direct read/edit/run action would finish the next step faster.")
  if (executionMode === "fork_context") {
    lines.push("- This is a forked-context sidecar: inherit parent context, keep the brief directive-style, and avoid restating the full parent thread.")
  } else {
    lines.push("- This is a fresh agent: assume zero inherited context and include all required context in the brief.")
  }
  if (isolation === "worktree") {
    lines.push("- Run this delegated slice inside a local detached git worktree. Keep all execution local and self-contained.")
  }
  lines.push("- Never delegate understanding of the problem itself; delegate execution, verification, or bounded research against an already-understood objective.")
  lines.push("- Do not guess unfinished results or treat background work as completed before it settles.")
  lines.push("- Do not fabricate completion or present unfinished work as done.")
  lines.push("- Do not peek at unfinished sibling work and turn guesses into facts.")
  lines.push("- Background delegates must stay non-interactive; if clarification is needed, keep the work in the foreground.")

  return lines.join("\n")
}

async function ensureDelegatedSession({ executionMode, parentSessionId, subSessionId }) {
  if (executionMode !== "fork_context") return

  if (!parentSessionId) {
    throw new Error("fork_context requires a parent session")
  }

  const existing = await getSession(subSessionId)
  if (existing) return

  const forked = await forkSession({
    sessionId: parentSessionId,
    newSessionId: subSessionId,
    title: `fork:${subSessionId}`
  })

  if (!forked) {
    throw new Error(`fork_context parent session not found: ${parentSessionId}`)
  }

  await flushNow()
}

export function createTaskDelegate({ config, parentSessionId, model, providerType, runSubtask }) {
  return async function delegateTask(args = {}) {
    const executionModeResult = normalizeExecutionMode(args.execution_mode)
    if (executionModeResult.error) return { error: executionModeResult.error }
    const executionMode = executionModeResult.mode
    const isolationResult = normalizeIsolation(args.isolation)
    if (isolationResult.error) return { error: isolationResult.error }
    const validationError = validateDelegationArgs(args, executionMode)
    if (validationError) return { error: validationError }
    const isolation = isolationResult.mode

    const subagent = resolveSubagent({
      config,
      subagentType: args.subagent_type || null,
      category: args.category || null
    })

    const subSessionId = String(args.session_id || `sub_${parentSessionId}_${Date.now()}`)
    const prompt = buildDelegationPrompt(args)

    const subModel = subagent.model || model
    const subProvider = subagent.providerType || providerType

    const run = async ({ isCancelled, log }) => {
      await ensureDelegatedSession({
        executionMode,
        parentSessionId,
        subSessionId
      })
      await log(`task started (${subagent.name})`)
      const out = await runSubtask({
        prompt,
        sessionId: subSessionId,
        model: subModel,
        providerType: subProvider,
        subagent,
        allowQuestion: args.allow_question === true
      })
      await log(out.reply)
      if (isCancelled()) return { cancelled: true }
      const fileChanges = extractFileChanges(out.toolEvents || [])
      const editFeedback = extractEditFeedbackFromToolEvents(out.toolEvents || [])
      return {
        session_id: subSessionId,
        parent_session_id: parentSessionId,
        subagent: subagent.name,
        execution_mode: executionMode,
        reply: out.reply,
        tool_events: out.toolEvents?.length || 0,
        file_changes: fileChanges,
        edit_feedback: editFeedback
      }
    }

    if (args.run_in_background) {
      const task = await BackgroundManager.launchDelegateTask({
        description: String(args.description || `background task (${subagent.name})`),
        payload: {
          parentSessionId,
          subSessionId,
          prompt,
          cwd: process.cwd(),
          model: subModel,
          providerType: subProvider,
          executionMode,
          isolation,
          subagent: subagent.name,
          category: args.category || null,
          subagentType: subagent.name,
          stageId: args.stage_id || null,
          logicalTaskId: args.task_id || null,
          plannedFiles: Array.isArray(args.planned_files) ? args.planned_files : [],
          allowQuestion: args.allow_question === true
        },
        config
      })
      return {
        background_task_id: task.id,
        status: task.status,
        session_id: subSessionId,
        execution_mode: executionMode,
        isolation
      }
    }

    return run({
      isCancelled: () => false,
      log: async () => {}
    })
  }
}
