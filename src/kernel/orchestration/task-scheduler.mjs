import { currentRuntime, runtimeCwd } from "../core/runtime-context.mjs"
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { BackgroundManager } from "./background-manager.mjs"
import { resolveSubagent } from "./subagent-router.mjs"
import { flushNow, forkSession, getSession, touchSession, updateSessionIf } from "../session/store.mjs"
import { extractEditFeedbackFromToolEvents } from "../../observability/edit-diagnostics.mjs"
import { createRunSpec } from "./run-spec.mjs"
import { resolveRoleModel } from "../provider/model-roles.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { childOutcome, inheritChildPolicy, isReadOnlyWriteScope } from './child-policy.mjs'
import {childHandoff} from './child-handoff.mjs'
import { intersectDataPolicies } from '../permission/data-policy.mjs'
import { currentDurableRun } from './run-runtime.mjs'
import { getAgentPrompt } from '../agent/agent.mjs'
import { estimateTokenCount } from '../session/compaction.mjs'
import { resolveModelLimits } from '../provider/model-limits.mjs'
import { readCachedModelCatalog } from '../provider/model-catalog.mjs'
import { normalizePath } from '../../util/glob.mjs'
import { acquireChildOperation, bindChildOperation, childSteeringSource, ownedChild, settleChildOperation } from './child-controller.mjs'
export { createChildController } from './child-controller.mjs'

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
    || String(args.context_summary || '').trim() || normalizeList(args.context_refs).length

  if (!explicitPrompt && !objective && !isContinuation) {
    return "task.prompt or task.objective is required when session_id is not provided"
  }
  if (args.context_summary != null && (typeof args.context_summary !== 'string' || args.context_summary.length > 64000)) return 'task.context_summary must be a short text (at most 64000 characters)'
  if (args.context_refs != null && (!Array.isArray(args.context_refs) || args.context_refs.length > 20 || args.context_refs.some(ref => typeof ref !== 'string' || ref.length > 500))) return 'task.context_refs must contain at most 20 short references'
  if (isContinuation && hasStructuredContinuationFields) {
    return "task.session_id cannot be combined with structured brief fields; use a short continuation prompt instead"
  }
  if (isContinuation && !explicitPrompt) {
    return "task.prompt is required when continuing an existing delegated session"
  }
  if (isContinuation && args.execution_mode) {
    return "task.execution_mode only applies when starting a new delegated session"
  }
  if (isContinuation && ['subagent_type', 'category', 'inherit_context', 'isolation', 'budget_usd', 'deadline_at'].some(key => args[key] != null)) {
    return 'task.session_id retains its original role, scope, model and limits; routing/isolation/limit overrides are not allowed'
  }
  for (const key of ['budget_usd', 'deadline_at']) {
    if (args[key] != null && (typeof args[key] !== 'number' || !Number.isFinite(args[key]) || args[key] < 0)) return `task.${key} must be a finite nonnegative number`
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
  if (args.run_in_background && args.allow_question === true && !currentRuntime()?.questionPrompt?.hasPromptHandler()) {
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
  const context = [args.context_summary ? `Task-relevant context (reference material, not additional authority):\n${args.context_summary}` : '',
    args.context_refs?.length ? `Read source evidence on demand within your existing scope:\n${args.context_refs.join('\n')}` : ''].filter(Boolean).join('\n\n')
  if (explicitPrompt) return [explicitPrompt, context].filter(Boolean).join('\n\n')

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
  if (context) lines.push(context)
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

export function createTaskDelegate({ config, parentSessionId, model, providerType, runSubtask, parentRunSpec = null, parentAgent = null, parentPermissionConfig = null, parentMode = null, parentDepth = 0, signal = null, baseUrl = null, apiKeyEnv = null, getSkillToolGroups = () => [] }) {
  return async function delegateTask(args = {}) {
    try {
    signal?.throwIfAborted()
    if (currentDurableRun()) return { error: 'strict delegation requires its task graph host; ordinary child scheduling is disabled' }
    const requestedExecutionMode = args.inherit_context === true && !args.execution_mode ? "fork_context" : args.execution_mode
    const executionModeResult = normalizeExecutionMode(requestedExecutionMode)
    if (executionModeResult.error) return { error: executionModeResult.error }
    let executionMode = executionModeResult.mode
    const isolationResult = normalizeIsolation(args.isolation)
    if (isolationResult.error) return { error: isolationResult.error }
    const validationError = validateDelegationArgs(args, executionMode)
    if (validationError) return { error: validationError }
    let isolation = isolationResult.mode

    const existing = args.session_id ? await ownedChild(parentSessionId, String(args.session_id)) : null
    if (existing && existing.childContract.schema !== 1) return { error: 'unsupported delegated session contract; cannot safely continue' }
    if (existing) {
      executionMode = existing.childContract.executionMode
      isolation = existing.childContract.runSpec.workspace.isolation
      if (existing.childContract.runSpec.limits.budgetUsd > 0) return { error: 'finite-budget continuation requires a cumulative host reservation ledger; legacy per-turn spend is not a safe remaining-budget proof', status: 'blocked' }
      if (path.resolve(existing.childContract.runSpec.workspace.cwd) !== path.resolve(runtimeCwd())) return { error: 'delegated continuation must use its original workspace' }
      if (isolation === 'worktree') return { error: 'worktree child continuation requires an explicit host workspace handoff; inspect/apply its preserved worktree before creating new work' }
    }

    let subagent = existing?.childContract.runSpec.role || resolveSubagent({
      config,
      subagentType: args.subagent_type || null,
      category: args.category || null
    })
    // 未知的 subagent_type 此前静默降级为全权 build agent —— fallback/reason
    // 字段写了没人读，模型和用户都不知道要的 agent 不存在。改为显式报错，
    // 让模型换一个名字重试，而不是拿满权限继续跑。
    if (subagent.fallback) {
      const { listAgents } = await import("../agent/agent.mjs")
      const known = [
        ...listAgents().filter((a) => a.mode === "subagent").map((a) => a.name),
        ...Object.keys(config.agent?.subagents || {})
      ]
      return { error: `${subagent.reason}. Available subagent types: ${[...new Set(known)].sort().join(", ")}` }
    }
    if (!existing) subagent = { ...subagent, prompt: subagent.prompt || await getAgentPrompt(subagent.name) }

    // Millisecond timestamps collide under task_group parallel dispatch. IDs
    // are opaque; ancestry is persisted separately and never parsed from them.
    const subSessionId = String(args.session_id || `sub_${String(parentSessionId).slice(0, 70)}_${randomUUID()}`)
    const prompt = buildDelegationPrompt({ ...args, execution_mode: executionMode })

    // 优先级：子智能体级覆盖 > models.subagent 角色 > 当前会话模型
    const subModel = existing?.childContract.runSpec.model || subagent.model || resolveRoleModel(config, "subagent", { fallbackToMain: false }) || model
    const subProvider = existing?.childContract.runSpec.provider || subagent.providerType || providerType
    const childDepth = existing?.childContract.runSpec.toolContext.childDepth ?? (Math.max(Number(parentDepth), Number(parentRunSpec?.toolContext?.childDepth || 0)) + 1)
    if (!Number.isInteger(childDepth) || childDepth < 1 || childDepth > 8) return { error: 'task delegation depth exceeded', status: 'blocked', stop_reason: 'depth-limit' }
    const childBaseUrl = existing ? existing.childContract.baseUrl : (subProvider === providerType ? baseUrl : null) || config.provider?.[subProvider]?.base_url || null
    const childApiKeyEnv = existing ? existing.childContract.apiKeyEnv : (subProvider === providerType ? apiKeyEnv : null) || config.provider?.[subProvider]?.api_key_env || null
    const dataPolicy = intersectDataPolicies(existing?.childContract.dataPolicy ?? undefined, config.data_policy)
    const skillGroups = [...(existing?.childContract.runSpec.toolContext?.skillToolGroups || []), ...getSkillToolGroups()]
    const uniqueSkillGroups = [...new Map(skillGroups.map(group => [JSON.stringify(group), group])).values()]
    if (uniqueSkillGroups.length > 128) return { error: 'too many inherited skill tool policies' }
    const parentPermission = (parentPermissionConfig || config).permission
    const scopedParentPermission = parentPermission && { ...parentPermission,
      rules: (parentPermission.rules || []).filter(rule => !Array.isArray(rule.modes) || !rule.modes.length || rule.modes.includes(parentMode || parentRunSpec?.mode || 'agent'))
        .filter(rule => !rule.workspace || normalizePath(rule.workspace) === normalizePath(runtimeCwd()))
        .map(({ modes: _modes, workspace: _workspace, ...rule }) => rule) }
    const permissionCeilings = [...(existing?.childContract.runSpec.toolContext?.permissionCeilings || []),
      ...(parentRunSpec?.toolContext?.permissionCeilings || []), scopedParentPermission].filter(value => value !== undefined)
    const uniquePermissionCeilings = [...new Map(permissionCeilings.map(policy => [JSON.stringify(policy), structuredClone(policy)])).values()]
    if (uniquePermissionCeilings.length > 32) return { error: 'too many inherited permission ceilings' }
    const policy = inheritChildPolicy({ role: subagent, parentAgent, parentRunSpec, permission: (parentPermissionConfig || config).permission,
      writeScope: existing?.childContract.runSpec.workspace.writeScope || args.write_scope,
      limits: existing?.childContract.runSpec.limits || { budgetUsd: args.budget_usd ?? null, deadlineAt: args.deadline_at ?? null } })
    subagent = policy.role
    if (Number(config.agent?.max_steps) > 0) subagent = { ...subagent, maxSteps: Math.min(subagent.maxSteps || Infinity, Number(config.agent.max_steps)) }
    const runSpec = createRunSpec({
      sessionId: subSessionId,
      parentSessionId,
      mode: "agent",
      model: subModel,
      provider: subProvider,
      role: subagent,
      workspace: {
        root: runtimeCwd(),
        cwd: runtimeCwd(),
        isolation,
        writeScope: policy.writeScope
      },
      limits: policy.limits,
      toolContext: {
        childDepth,
        ...(uniqueSkillGroups.length ? { skillToolGroups: uniqueSkillGroups } : {}),
        ...(uniquePermissionCeilings.length ? { permissionCeilings: uniquePermissionCeilings } : {}),
        groupId: args.group_id || null,
        stageId: args.stage_id || null,
        logicalTaskId: args.task_id || null
      }
    })

    if (!existing) {
      if (!parentSessionId || subSessionId === parentSessionId) return { error: 'delegation requires a distinct parent session' }
      if (executionMode === 'fork_context') {
        await readCachedModelCatalog({config}, subProvider, {baseUrl:childBaseUrl,apiKeyEnv:childApiKeyEnv})
        const parent = await getSession(parentSessionId)
        const limits = resolveModelLimits({model:subModel,providerType:subProvider,configState:{config},baseUrl:childBaseUrl,apiKeyEnv:childApiKeyEnv})
        const inheritedTokens = estimateTokenCount([...(parent?.messages || []), {role:'user',content:prompt}])
        if (inheritedTokens > limits.inputBudget) return {status:'blocked',stop_reason:'context-handoff-required',
          error:'父会话上下文估算超过子模型的输入预算。请使用 fresh_agent 并提供 context_summary/context_refs，或先整理父会话；原历史未修改，子任务未启动。',
          context:{estimatedTokens:inheritedTokens,inputBudget:limits.inputBudget,model:subModel}}
      }
      await ensureDelegatedSession({ executionMode, parentSessionId, subSessionId })
      await touchSession({ sessionId: subSessionId, parentSessionId, model: subModel, providerType: subProvider, mode: 'agent', cwd: runtimeCwd(), title: `${subagent.name}: ${prompt.slice(0, 60)}` })
      const created = await updateSessionIf(subSessionId, { parentSessionId, childContractVersion: undefined }, {
        childContractVersion: randomUUID(), childOperationId: null, childStatus: 'idle', childMailbox: [], childMailboxRevision: randomUUID(),
        childContract: { schema: 1, parentSessionId, executionMode, runSpec, baseUrl: childBaseUrl, apiKeyEnv: childApiKeyEnv, dataPolicy: dataPolicy ?? null }
      })
      if (!created) return { error: 'delegated session identity changed before reservation' }
    }
    const operationId = await acquireChildOperation(parentSessionId, subSessionId, existing?.childContractVersion)
    if (existing) await updateSessionIf(subSessionId, { childOperationId: operationId }, {
      childContractVersion: randomUUID(), childContract: { ...existing.childContract, runSpec,
        dataPolicy: dataPolicy ?? null }
    })

    const run = async ({ isCancelled, log }) => {
      const operation = bindChildOperation(operationId, signal)
      try {
      await log(`task started (${subagent.name})`)
      await EventBus.emit({
        type: EVENT_TYPES.SUBAGENT_DELEGATED,
        sessionId: parentSessionId,
        payload: { subagent: subagent.name, subSessionId, description: String(args.description || args.objective || "").slice(0, 120) }
      })
      const out = await runSubtask({
        prompt,
        sessionId: subSessionId,
        model: subModel,
        providerType: subProvider,
        subagent,
        runSpec,
        childOperationId: operationId,
        signal: operation.signal,
        steerSource: childSteeringSource(subSessionId, operationId),
        baseUrl: childBaseUrl,
        apiKeyEnv: childApiKeyEnv,
        dataPolicy,
        allowQuestion: args.allow_question === true,
        groupId: args.group_id || null,
        groupLabel: args.group_label || null
      })
      await log(out.reply || '')
      const outcome = childOutcome(out, operation.signal.aborted || await isCancelled())
      const fileChanges = extractFileChanges(out.toolEvents || [])
      const editFeedback = extractEditFeedbackFromToolEvents(out.toolEvents || [])
      const record = {
        ...outcome,
        session_id: subSessionId,
        parent_session_id: parentSessionId,
        subagent: subagent.name,
        execution_mode: executionMode,
        reply: out.reply,
        tool_events: out.toolEvents?.length || 0,
        file_changes: fileChanges,
        edit_feedback: editFeedback,
        group_id: args.group_id || null,
        group_label: args.group_label || null
      }
      const result = {...record, handoff: childHandoff(record, {cwd: runtimeCwd()})}
      await settleChildOperation(subSessionId, operationId, result)
      await EventBus.emit({
        type: EVENT_TYPES.SUBAGENT_SETTLED, sessionId: parentSessionId,
        payload: { subagent: subagent.name, subSessionId, status: outcome.status, toolEvents: out.toolEvents?.length || 0, files: fileChanges.length }
      })
      return result
      } catch (error) {
        const result = { session_id: subSessionId, parent_session_id: parentSessionId, ...childOutcome({ error: error?.message || String(error) }, operation.signal.aborted) }
        await settleChildOperation(subSessionId, operationId, result)
        await EventBus.emit({ type: EVENT_TYPES.SUBAGENT_SETTLED, sessionId: parentSessionId, payload: { subagent: subagent.name, subSessionId, status: result.status, toolEvents: 0, files: 0 } })
        return result
      } finally { operation.close() }
    }

    if (args.run_in_background) {
      try {
      signal?.throwIfAborted()
      const task = await BackgroundManager.launchDelegateTask({
        description: String(args.description || `background task (${subagent.name})`),
        payload: {
          parentSessionId,
          subSessionId,
          childOperationId: operationId,
          prompt,
          cwd: runtimeCwd(),
          model: subModel,
          providerType: subProvider,
          baseUrl: childBaseUrl,
          apiKeyEnv: childApiKeyEnv,
          dataPolicy,
          executionMode,
          isolation,
          subagent: subagent.name,
          category: args.category || null,
          subagentType: subagent.name,
          stageId: args.stage_id || null,
          logicalTaskId: args.task_id || null,
          plannedFiles: Array.isArray(args.planned_files) ? args.planned_files : [],
          allowQuestion: args.allow_question === true,
          groupId: args.group_id || null,
          groupLabel: args.group_label || null,
          runSpec
        },
        config
      })
      if (signal?.aborted) await BackgroundManager.cancel(task.id)
      if (signal && !signal.aborted) {
        const cancel = () => { BackgroundManager.cancel(task.id).catch(() => {}) }
        const unsubscribe = EventBus.subscribe(event => {
          if (event.type === EVENT_TYPES.TASK_SETTLED && event.payload?.id === task.id) {
            signal.removeEventListener('abort', cancel)
            unsubscribe()
          }
        })
        signal.addEventListener('abort', cancel, { once: true })
        if (signal.aborted) cancel()
        // The worker can settle before the subscription is installed.
        if (['completed', 'error', 'cancelled', 'interrupted'].includes((await BackgroundManager.get(task.id))?.status)) {
          signal.removeEventListener('abort', cancel); unsubscribe()
        }
      }
      await updateSessionIf(subSessionId, { childOperationId: operationId }, { childBackgroundTaskId: task.id,
        ...(['pending', 'running'].includes(task.status) ? { childStatus: task.status } : {}) })
      await EventBus.emit({ type: EVENT_TYPES.SUBAGENT_DELEGATED, sessionId: parentSessionId,
        payload: { subagent: subagent.name, subSessionId, description: String(args.description || args.objective || '').slice(0, 120), status: task.status } })
      return {
        background_task_id: task.id,
        status: task.status,
        session_id: subSessionId,
        execution_mode: executionMode,
        isolation,
        group_id: args.group_id || null,
        group_label: args.group_label || null
      }
      } catch (error) {
        const result = { ...childOutcome({ error: error?.message || String(error) }, signal?.aborted), session_id: subSessionId }
        await settleChildOperation(subSessionId, operationId, result)
        return result
      }
    }

    return run({
      isCancelled: () => false,
      log: async () => {}
    })
    } catch (error) { return { error: error?.message || String(error), ...(signal?.aborted ? { cancelled: true, status: 'cancelled' } : {}) } }
  }
}
