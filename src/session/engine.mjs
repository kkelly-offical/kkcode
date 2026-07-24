import { randomUUID } from "node:crypto"
import { loadPricing, calculateCost } from "../usage/pricing.mjs"
import { recordTurn } from "../usage/usage-meter.mjs"
import { processTurnLoop } from "./loop.mjs"
import { runLongAgent } from "./longagent.mjs"
import { touchSession, setBudgetState } from "./store.mjs"
import { appendEventLog } from "../storage/event-log.mjs"
import { EventBus } from "../core/events.mjs"
import { initialize as initObservability } from "../observability/index.mjs"
import { ToolRegistry } from "../tool/registry.mjs"
import { SkillRegistry } from "../skill/registry.mjs"
import { resolveAgentForMode } from "../agent/agent.mjs"
import { estimateStringTokens } from "./compaction.mjs"
import { classifyTaskMode, explainTaskModeReason } from "./longagent-utils.mjs"
import { resolveExtensionPolicy } from "../context.mjs"

let sinkReady = false

export const PUBLIC_MODE_CONTRACT = Object.freeze([
  {
    mode: "assistant",
    summary: "default CLI personal assistant lane",
    guarantee: "assistant handles bounded terminal-native personal assistant work under normal tool permissions"
  },
  {
    mode: "plan",
    summary: "produce a spec/plan only",
    guarantee: "plan does not execute file mutations"
  },
  {
    mode: "agent",
    summary: "compatibility alias for assistant",
    guarantee: "agent/code/coding resolve to the unified assistant in 0.3.0"
  },
  {
    mode: "longagent",
    summary: "heavyweight staged multi-file delivery lane",
    guarantee: "longagent stays reserved for structured multi-file or system-level work"
  }
])

function estimateTokens(text) {
  return Math.max(1, estimateStringTokens(text || ""))
}

export function resolveMode(inputMode = "assistant") {
  const mode = String(inputMode || "assistant").toLowerCase()
  if (mode === "agent" || mode === "code" || mode === "coding" || mode === "ask") return "assistant"
  if (["assistant", "plan", "longagent"].includes(mode)) return mode
  return "assistant"
}

export function getPublicModeContract(inputMode = "assistant") {
  const mode = resolveMode(inputMode)
  return PUBLIC_MODE_CONTRACT.find((item) => item.mode === mode) || PUBLIC_MODE_CONTRACT[0]
}

export function formatPublicModeSummary(inputMode = "assistant") {
  const contract = getPublicModeContract(inputMode)
  return `${contract.mode}: ${contract.summary}`
}

export function renderPublicModeContract() {
  return [
    "# Mode Contract",
    "",
    "- `assistant`: default CLI personal assistant lane for bounded terminal-native personal work, explanation, and analysis.",
    "- `plan`: produce a spec/plan only; do not execute file mutations.",
    "- `agent` / `code` / `coding`: compatibility aliases for `assistant` in 0.3.0.",
    "- `longagent`: heavyweight staged multi-file delivery lane with explicit gates.",
    "- Keep everyday Q&A, coding mutation, debugging, refactoring, and test repair in `assistant`.",
    "- Suggest `longagent` only when heavy multi-file or system-level evidence appears; do not auto-switch.",
    "- Keep `plan` explicit and mutation-free even when later execution is likely."
  ].join("\n")
}

function summarizeRouteEvidence(classification) {
  const evidence = Array.isArray(classification?.evidence) ? classification.evidence : []
  if (!evidence.length) return "evidence=none"
  return `evidence=${evidence.join(", ")}`
}

function summarizeRouteTopology(classification) {
  const topology = classification?.topology || "open_ended"
  const continuity = classification?.continuity || "new_transaction"
  return `topology=${topology}; continuity=${continuity}`
}

export function summarizeRouteDecision(route) {
  if (!route) return ""
  const parts = [summarizeRouteTopology(route), summarizeRouteEvidence(route)]
  if (route.suggestion) parts.push(`upgrade_path=${route.mode}->${route.suggestion}`)
  return parts.join("; ")
}

/**
 * 智能模式路由：根据 prompt 内容判断最适合的执行模式
 * @returns {{ mode: string, changed: boolean, reason: string, confidence: string, forced: boolean }}
 *   forced=true 表示用户强制使用了不匹配的模式（需要确认）
 */
function finalizeRouteDecision(req, classification, base = {}) {
  const effectiveMode = base.changed ? base.mode : req
  const evidenceSummary = summarizeRouteEvidence(classification)
  const topologySummary = summarizeRouteTopology(classification)
  const upgradePath = base.suggestion ? `${effectiveMode}->${base.suggestion}` : null
  return {
    ...base,
    modeContract: getPublicModeContract(effectiveMode),
    topology: classification.topology || "open_ended",
    evidence: Array.isArray(classification.evidence) ? classification.evidence : [],
    pathHints: Array.isArray(classification.pathHints) ? classification.pathHints : [],
    continuity: classification.continuity || "new_transaction",
    evidenceSummary,
    topologySummary,
    upgradePath,
    observability: {
      requestedMode: req,
      effectiveMode,
      suggestedMode: classification.mode,
      changed: Boolean(base.changed),
      forced: Boolean(base.forced),
      suggestion: base.suggestion || null,
      modeContract: getPublicModeContract(effectiveMode),
      reason: base.reason,
      confidence: base.confidence,
      topology: classification.topology || "open_ended",
      evidence: Array.isArray(classification.evidence) ? classification.evidence : [],
      pathHints: Array.isArray(classification.pathHints) ? classification.pathHints : [],
      continuity: classification.continuity || "new_transaction",
      evidenceSummary,
      topologySummary,
      upgradePath,
      stayedLocal: (effectiveMode === "assistant" && ["assistant", "agent"].includes(classification.mode)) || (effectiveMode === "agent" && classification.mode === "agent"),
      deferredLongagent: (req === "assistant" || req === "agent") && base.suggestion === "longagent",
      overEscalatedToLongagent: req === "longagent" && classification.mode === "agent"
    }
  }
}

export function routeMode(prompt, requestedMode, options = {}) {
  const req = resolveMode(requestedMode)
  // plan 模式不参与自动路由
  if (req === "plan") {
    return finalizeRouteDecision(req, {
      mode: req,
      topology: "open_ended",
      evidence: [],
      pathHints: [],
      continuity: "new_transaction"
    }, {
      mode: req,
      changed: false,
      reason: "plan_mode_exempt",
      explanation: explainTaskModeReason("plan_mode_exempt"),
      confidence: "high",
      forced: false
    })
  }

  const classification = classifyTaskMode(prompt, options)
  const suggested = classification.mode
  const explanation = classification.explanation || explainTaskModeReason(classification.reason)

  // 相同模式，无需路由
  if (suggested === req) {
    return finalizeRouteDecision(req, classification, { mode: req, changed: false, reason: classification.reason, explanation, confidence: classification.confidence, forced: false })
  }

  // 低置信度不自动路由
  if (classification.confidence === "low") {
    return finalizeRouteDecision(req, classification, { mode: req, changed: false, reason: "low_confidence", explanation: explainTaskModeReason("low_confidence"), confidence: "low", forced: false })
  }

  // 高置信度：assistant/agent 模式下检测到 longagent 任务 → 建议切换（无需确认，只提示）
  if ((req === "assistant" || req === "agent") && suggested === "longagent" && classification.confidence === "high") {
    return finalizeRouteDecision(req, classification, { mode: req, changed: false, reason: classification.reason, explanation, confidence: "high", forced: false, suggestion: "longagent" })
  }

  // 高置信度：用户强制 longagent 但任务是简单本地任务 → 需要确认
  if (req === "longagent" && (suggested === "agent" || suggested === "assistant") && classification.confidence === "high") {
    return finalizeRouteDecision(req, classification, { mode: req, changed: false, reason: classification.reason, explanation, confidence: "high", forced: true, suggestion: "assistant" })
  }

  return finalizeRouteDecision(req, classification, { mode: req, changed: false, reason: classification.reason, explanation, confidence: classification.confidence, forced: false })
}

export function resolvePromptMode(prompt, requestedMode = "agent", options = {}) {
  const requested = resolveMode(requestedMode)
  const route = routeMode(prompt, requested, options)
  return {
    requestedMode: requested,
    effectiveMode: route.changed ? route.mode : requested,
    effectiveContract: getPublicModeContract(route.changed ? route.mode : requested),
    route
  }
}

export function newSessionId() {
  return `ses_${randomUUID().slice(0, 12)}`
}

export function ensureEventSinks() {
  if (sinkReady) return
  EventBus.registerSink(async (event) => {
    await appendEventLog(event)
  })
  initObservability(EventBus)
  sinkReady = true
}

function evaluateBudget(config, meter) {
  const budget = config.usage?.budget || {}
  const warnings = []
  const strategy = budget.strategy || "warn"
  const warnAt = Number(budget.warn_at_percent || 80)
  let exceeded = false

  if (budget.session_usd && meter.session.cost > 0) {
    const ratio = (meter.session.cost / budget.session_usd) * 100
    if (ratio >= 100) exceeded = true
    if (ratio >= warnAt) warnings.push(`session budget ${ratio.toFixed(1)}% (${meter.session.cost.toFixed(4)}/${budget.session_usd})`)
  }
  if (budget.global_usd && meter.global.cost > 0) {
    const ratio = (meter.global.cost / budget.global_usd) * 100
    if (ratio >= 100) exceeded = true
    if (ratio >= warnAt) warnings.push(`global budget ${ratio.toFixed(1)}% (${meter.global.cost.toFixed(4)}/${budget.global_usd})`)
  }
  return { warnings, exceeded, strategy }
}

export async function executeTurn({
  prompt,
  contentBlocks = null,
  mode,
  model,
  sessionId,
  configState,
  providerType = null,
  baseUrl = null,
  apiKeyEnv = null,
  maxIterations = null,
  signal = null,
  output = null,
  allowQuestion = true,
  toolContext = {},
  longagentImpl = null,
  runSpec = null
}) {
  ensureEventSinks()

  const resolvedProviderType = providerType || configState.config.provider.default
  const agent = resolveAgentForMode(mode)
  const extensionPolicy = resolveExtensionPolicy(configState)
  await ToolRegistry.initialize({
    config: extensionPolicy.config,
    cwd: process.cwd(),
    allowProjectSources: extensionPolicy.allowProjectSources
  })
  await SkillRegistry.initialize(extensionPolicy.config, process.cwd(), {
    allowProjectSources: extensionPolicy.allowProjectSources
  })
  // Auto-name session from first user prompt (truncated to 50 chars)
  const autoTitle = typeof prompt === "string"
    ? prompt.replace(/\s+/g, " ").trim().slice(0, 50)
    : null
  await touchSession({
    sessionId,
    mode,
    model,
    providerType: resolvedProviderType,
    cwd: process.cwd(),
    title: autoTitle || null,
    status: mode === "longagent" ? "running-longagent" : "active"
  })

  const turn =
    mode === "longagent"
      ? await runLongAgent({
          prompt,
          model,
          providerType: resolvedProviderType,
          sessionId,
          configState,
          baseUrl,
          apiKeyEnv,
          agent,
          maxIterations:
            maxIterations === null
              ? Number(configState.config.agent.longagent.max_iterations || 0)
              : Number(maxIterations),
          signal,
          output,
          allowQuestion,
          toolContext,
          runSpec,
          longagentImpl
        })
      : await processTurnLoop({
          prompt,
          contentBlocks,
          mode,
          model,
          providerType: resolvedProviderType,
          sessionId,
          configState,
          baseUrl,
          apiKeyEnv,
          agent,
          output,
          signal,
          allowQuestion,
          toolContext,
          runSpec
        })

  const usage = { ...turn.usage }
  let estimated = false
  if ((usage.input || 0) === 0 && (usage.output || 0) === 0) {
    usage.input = estimateTokens(prompt)
    usage.output = estimateTokens(turn.reply)
    estimated = true
  }

  const pricingInfo = await loadPricing(configState)
  const costInfo = calculateCost(pricingInfo.pricing, model, usage)
  const meter = await recordTurn({ sessionId, usage, cost: costInfo.amount })
  const budgetResult = evaluateBudget(configState.config, meter)

  await setBudgetState(sessionId, {
    lastTurnCost: costInfo.amount,
    warnings: budgetResult.warnings,
    exceeded: budgetResult.exceeded,
    updatedAt: Date.now()
  })

  if (budgetResult.exceeded && budgetResult.strategy === "block") {
    const msg = `budget exceeded — ${budgetResult.warnings.join("; ")}. strategy=block, stopping execution.`
    return {
      reply: msg,
      mode,
      model,
      sessionId,
      turnId: turn.turnId,
      emittedText: turn.emittedText,
      context: turn.context,
      tokenMeter: { ...meter, estimated: estimated || costInfo.unknown },
      cost: costInfo.amount,
      costSavings: costInfo.savings,
      pricingWarnings: pricingInfo.errors,
      budgetWarnings: budgetResult.warnings,
      budgetExceeded: true,
      toolEvents: turn.toolEvents,
      longagent: mode === "longagent"
        ? {
            status: turn.status,
            phase: turn.phase,
            gateStatus: turn.gateStatus,
            currentGate: turn.currentGate,
            lastGateFailures: turn.lastGateFailures || [],
            iterations: turn.iterations,
            recoveryCount: turn.recoveryCount,
            progress: turn.progress,
            elapsed: turn.elapsed,
            stageIndex: turn.stageIndex,
            stageCount: turn.stageCount,
            currentStageId: turn.currentStageId,
            planFrozen: turn.planFrozen,
            taskProgress: turn.taskProgress,
            stageProgress: turn.stageProgress,
            remainingFilesCount: turn.remainingFilesCount,
            fileChanges: turn.fileChanges || []
          }
        : null
    }
  }

  return {
    reply: turn.reply,
    mode,
    model,
    sessionId,
    turnId: turn.turnId,
    emittedText: turn.emittedText,
    context: turn.context,
    tokenMeter: { ...meter, estimated: estimated || costInfo.unknown },
    cost: costInfo.amount,
    costSavings: costInfo.savings,
    pricingWarnings: pricingInfo.errors,
    budgetWarnings: budgetResult.warnings,
    budgetExceeded: false,
    toolEvents: turn.toolEvents,
    longagent: mode === "longagent"
      ? {
          status: turn.status,
          phase: turn.phase,
          gateStatus: turn.gateStatus,
          currentGate: turn.currentGate,
          lastGateFailures: turn.lastGateFailures || [],
          iterations: turn.iterations,
          recoveryCount: turn.recoveryCount,
          progress: turn.progress,
          elapsed: turn.elapsed,
          stageIndex: turn.stageIndex,
          stageCount: turn.stageCount,
          currentStageId: turn.currentStageId,
          planFrozen: turn.planFrozen,
          taskProgress: turn.taskProgress,
          stageProgress: turn.stageProgress,
          remainingFilesCount: turn.remainingFilesCount,
          fileChanges: turn.fileChanges || []
        }
      : null
  }
}
