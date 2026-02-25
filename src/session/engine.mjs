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
import { resolveAgentForMode } from "../agent/agent.mjs"
import { estimateStringTokens } from "./compaction.mjs"

let sinkReady = false

function estimateTokens(text) {
  return Math.max(1, estimateStringTokens(text || ""))
}

export function resolveMode(inputMode = "agent") {
  const mode = String(inputMode || "agent").toLowerCase()
  if (["ask", "plan", "agent", "longagent"].includes(mode)) return mode
  return "agent"
}

export function newSessionId() {
  return `ses_${randomUUID().slice(0, 12)}`
}

function maybeRegisterSink() {
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
  toolContext = {}
}) {
  maybeRegisterSink()

  const resolvedProviderType = providerType || configState.config.provider.default
  const agent = resolveAgentForMode(mode)
  await ToolRegistry.initialize({
    config: configState.config,
    cwd: process.cwd()
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
          toolContext
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
