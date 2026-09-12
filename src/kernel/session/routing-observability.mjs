import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"

export async function emitRouteDecisionEvent({
  sessionId,
  source = "repl",
  requestedMode,
  route,
  prompt,
  continuedTransaction = false
}) {
  if (!route) return null
  return EventBus.emit({
    type: EVENT_TYPES.ROUTE_DECISION,
    sessionId,
    payload: {
      source,
      requestedMode,
      selectedMode: route.mode,
      changed: route.changed === true,
      forced: route.forced === true,
      suggestion: route.suggestion || null,
      reason: route.reason || null,
      explanation: route.explanation || null,
      confidence: route.confidence || null,
      topology: route.topology || null,
      continuity: route.continuity || null,
      evidenceSummary: route.evidenceSummary || null,
      topologySummary: route.topologySummary || null,
      upgradePath: route.upgradePath || null,
      evidence: Array.isArray(route.evidence) ? route.evidence : [],
      promptLength: String(prompt || "").trim().length,
      continuedTransaction
    }
  })
}

export async function emitAgentContinuationInterrupted({
  sessionId,
  summary
}) {
  return EventBus.emit({
    type: EVENT_TYPES.AGENT_CONTINUATION_INTERRUPTED,
    sessionId,
    payload: {
      objective: summary?.objective || null,
      paths: Array.isArray(summary?.paths) ? summary.paths : [],
      commands: Array.isArray(summary?.commands) ? summary.commands : [],
      routeReason: summary?.routeReason || null,
      evidence: Array.isArray(summary?.evidence) ? summary.evidence : []
    }
  })
}

export async function emitAgentContinuationResumed({
  sessionId,
  summary,
  continuation
}) {
  return EventBus.emit({
    type: EVENT_TYPES.AGENT_CONTINUATION_RESUMED,
    sessionId,
    payload: {
      objective: summary?.objective || null,
      paths: Array.isArray(summary?.paths) ? summary.paths : [],
      commands: Array.isArray(summary?.commands) ? summary.commands : [],
      routeReason: summary?.routeReason || null,
      evidence: Array.isArray(summary?.evidence) ? summary.evidence : [],
      continuationLength: String(continuation || "").trim().length
    }
  })
}
