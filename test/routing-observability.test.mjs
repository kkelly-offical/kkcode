import test from "node:test"
import assert from "node:assert/strict"
import { routeMode } from "../src/session/engine.mjs"
import { createMetricsCollector } from "../src/observability/metrics.mjs"
import { EVENT_TYPES } from "../src/core/constants.mjs"

function makeEvent(type, payload = {}) {
  return {
    id: `evt_route_${Date.now()}`,
    type,
    sessionId: "ses_route_obs",
    turnId: "turn_route_obs",
    timestamp: Date.now(),
    payload
  }
}

test("route decisions expose topology and evidence for observability", () => {
  const route = routeMode(
    "Check ./logs/app.log, patch README.md, then run npm test to verify the command.",
    "agent"
  )

  assert.equal(route.topology, "bounded_local_transaction")
  assert.ok(route.evidence.includes("inspect_patch_verify"))
  assert.equal(route.observability.stayedLocal, true)
  assert.equal(route.observability.requestedMode, "agent")
  assert.match(route.observability.topologySummary, /bounded_local_transaction/)
  assert.match(route.observability.evidenceSummary, /inspect_patch_verify/)
})

test("metrics collect stayed-local, over-escalation, and continuation counters", () => {
  const metrics = createMetricsCollector()
  metrics.handleEvent(makeEvent(EVENT_TYPES.ROUTE_DECISION, {
    stayedLocal: true,
    deferredLongagent: true,
    overEscalatedToLongagent: false
  }))
  metrics.handleEvent(makeEvent(EVENT_TYPES.ROUTE_DECISION, {
    stayedLocal: false,
    deferredLongagent: false,
    overEscalatedToLongagent: true
  }))
  metrics.handleEvent(makeEvent(EVENT_TYPES.AGENT_CONTINUATION_RESUMED, {
    topology: "bounded_local_transaction"
  }))

  const snapshot = metrics.getSnapshot()
  assert.equal(snapshot.counters.get("route_decision_count"), 2)
  assert.equal(snapshot.counters.get("route_stayed_local_count"), 1)
  assert.equal(snapshot.counters.get("route_deferred_longagent_count"), 1)
  assert.equal(snapshot.counters.get("route_over_escalated_longagent_count"), 1)
  assert.equal(snapshot.counters.get("agent_continuation_count"), 1)
})
