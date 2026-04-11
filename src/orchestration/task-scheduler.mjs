import { BackgroundManager } from "./background-manager.mjs"
import { resolveSubagent } from "./subagent-router.mjs"
import { flushNow, forkSession, getSession } from "../session/store.mjs"
import { extractEditFeedbackFromToolEvents } from "../observability/edit-diagnostics.mjs"

const SUPPORTED_EXECUTION_MODES = new Set(["fresh_agent", "fork_context"])

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

function buildDelegationPrompt(args = {}) {
  const explicitPrompt = String(args.prompt || "").trim()
  if (explicitPrompt) return explicitPrompt
  if (args.session_id) return "Continue from existing sub-session context."

  const objective = String(args.objective || "").trim()
  if (!objective) return ""

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
  lines.push("- Do not fabricate completion or present unfinished work as done.")
  lines.push("- Do not peek at unfinished sibling work and turn guesses into facts.")

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

    const subagent = resolveSubagent({
      config,
      subagentType: args.subagent_type || null,
      category: args.category || null
    })

    const subSessionId = String(args.session_id || `sub_${parentSessionId}_${Date.now()}`)
    const prompt = buildDelegationPrompt(args)

    if (!prompt) {
      return { error: "task.prompt or task.objective is required when session_id is not provided" }
    }

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
        execution_mode: executionMode
      }
    }

    return run({
      isCancelled: () => false,
      log: async () => {}
    })
  }
}
