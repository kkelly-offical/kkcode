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

let sinkReady = false

export const PUBLIC_MODE_CONTRACT = Object.freeze([
  {
    mode: "ask",
    summary: "read-only explanation and analysis",
    guarantee: "ask never mutates repo state"
  },
  {
    mode: "plan",
    summary: "produce a spec/plan only",
    guarantee: "plan does not execute file mutations"
  },
  {
    mode: "agent",
    summary: "default bounded local execution lane",
    guarantee: "agent is the default lane for bounded inspect/patch/verify work"
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

export function resolveMode(inputMode = "agent") {
  const mode = String(inputMode || "agent").toLowerCase()
  if (["ask", "plan", "agent", "longagent"].includes(mode)) return mode
  return "agent"
}

export function getPublicModeContract(inputMode = "agent") {
  const mode = resolveMode(inputMode)
  return PUBLIC_MODE_CONTRACT.find((item) => item.mode === mode) || PUBLIC_MODE_CONTRACT[2]
}

export function formatPublicModeSummary(inputMode = "agent") {
  const contract = getPublicModeContract(inputMode)
  return `${contract.mode}: ${contract.summary}`
}

export function renderPublicModeContract() {
  return [
    "# Mode Contract",
    "",
    "- `ask`: read-only explanation and analysis; never mutate repo state.",
    "- `plan`: produce a spec/plan only; do not execute file mutations.",
    "- `agent`: default bounded local execution lane for inspect/patch/verify work.",
    "- `longagent`: heavyweight staged multi-file delivery lane with explicit gates.",
    "- Upgrade from `agent` to `longagent` only when heavy multi-file or system-level evidence appears.",
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
      stayedLocal: effectiveMode === "agent" && classification.mode === "agent",
      deferredLongagent: req === "agent" && base.suggestion === "longagent",
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

  // 高置信度：问答类 → 自动切换到 ask（无需确认）
  if (suggested === "ask" && classification.confidence === "high") {
    return finalizeRouteDecision(req, classification, { mode: "ask", changed: true, reason: classification.reason, explanation, confidence: "high", forced: false })
  }

  // 高置信度：agent 模式下检测到 longagent 任务 → 建议切换（无需确认，只提示）
  if (req === "agent" && suggested === "longagent" && classification.confidence === "high") {
    return finalizeRouteDecision(req, classification, { mode: req, changed: false, reason: classification.reason, explanation, confidence: "high", forced: false, suggestion: "longagent" })
  }

  // 高置信度：用户强制 longagent 但任务是简单 agent 任务 → 需要确认
  if (req === "longagent" && suggested === "agent" && classification.confidence === "high") {
    return finalizeRouteDecision(req, classification, { mode: req, changed: false, reason: classification.reason, explanation, confidence: "high", forced: true, suggestion: "agent" })
  }

  // 中等置信度：agent 模式下检测到问答 → 自动切换
  if (req === "agent" && suggested === "ask" && classification.confidence === "medium") {
    return finalizeRouteDecision(req, classification, { mode: "ask", changed: true, reason: classification.reason, explanation, confidence: "medium", forced: false })
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
  longagentImpl = null
}) {
  ensureEventSinks()

  const resolvedProviderType = providerType || configState.config.provider.default
  const agent = resolveAgentForMode(mode)
  await ToolRegistry.initialize({
    config: configState.config,
    cwd: process.cwd()
  })
  await SkillRegistry.initialize(configState.config, process.cwd())
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
          toolContext
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
