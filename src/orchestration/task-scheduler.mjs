import { BackgroundManager } from "./background-manager.mjs"
import { resolveSubagent } from "./subagent-router.mjs"
import { flushNow, forkSession, getSession } from "../session/store.mjs"

const SUPPORTED_EXECUTION_MODES = new Set(["fresh_agent", "fork_context"])

function normalizeExecutionMode(raw) {
  const mode = String(raw || "fresh_agent").trim().toLowerCase() || "fresh_agent"
  if (!SUPPORTED_EXECUTION_MODES.has(mode)) {
    return { error: `unsupported task.execution_mode: ${raw}` }
  }
  return { mode }
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
    const prompt = String(args.prompt || "").trim() || (args.session_id ? "Continue from existing sub-session context." : "")

    if (!prompt) {
      return { error: "task.prompt is required when session_id is not provided" }
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
      return {
        session_id: subSessionId,
        parent_session_id: parentSessionId,
        subagent: subagent.name,
        execution_mode: executionMode,
        reply: out.reply,
        tool_events: out.toolEvents?.length || 0
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
