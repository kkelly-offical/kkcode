import test from "node:test"
import assert from "node:assert/strict"
import { createMetricsCollector } from "../src/observability/metrics.mjs"
import { EVENT_TYPES } from "../src/core/constants.mjs"

function makeEvent(type, payload = {}) {
  return {
    id: `evt_${type}_${Date.now()}`,
    type,
    sessionId: "ses_agent_obs",
    turnId: "turn_agent_obs",
    timestamp: Date.now(),
    payload
  }
}

test("metrics track route evidence and agent continuation lifecycle", () => {
  const metrics = createMetricsCollector()

  metrics.handleEvent(makeEvent(EVENT_TYPES.ROUTE_DECISION, {
    requestedMode: "agent",
    selectedMode: "agent",
    changed: false,
    suggestion: "longagent",
    continuedTransaction: true,
    evidence: ["local_task_signal", "inspect_patch_verify_loop"]
  }))
  metrics.handleEvent(makeEvent(EVENT_TYPES.AGENT_CONTINUATION_INTERRUPTED, {
    objective: "Inspect logs and patch one config"
  }))
  metrics.handleEvent(makeEvent(EVENT_TYPES.AGENT_CONTINUATION_RESUMED, {
    objective: "Inspect logs and patch one config",
    continuationLength: 42
  }))

  const snap = metrics.getSnapshot()
  assert.equal(snap.counters.get("route_decision_count"), 1)
  assert.equal(snap.counters.get("route_longagent_suggestion_count"), 1)
  assert.equal(snap.counters.get("route_continuation_count"), 1)
  assert.equal(snap.counters.get("route_evidence_local_task_signal"), 1)
  assert.equal(snap.counters.get("route_evidence_inspect_patch_verify_loop"), 1)
  assert.equal(snap.counters.get("agent_continuation_interrupted_count"), 1)
  assert.equal(snap.counters.get("agent_continuation_resumed_count"), 1)
})
