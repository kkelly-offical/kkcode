import test from "node:test"
import assert from "node:assert/strict"
import { createMetricsCollector } from "../src/observability/metrics.mjs"
import { createTracer } from "../src/observability/tracer.mjs"
import { EVENT_TYPES } from "../src/core/constants.mjs"

import { initialize, shutdown, getMetrics, getTraces, exportReport } from "../src/observability/index.mjs"
import { EventBus } from "../src/core/events.mjs"

function makeEvent(type, payload = {}, overrides = {}) {
  return {
    id: `evt_test_${Date.now()}`,
    type,
    sessionId: "ses_test",
    turnId: overrides.turnId || "turn_test",
    timestamp: overrides.timestamp || Date.now(),
    payload
  }
}

test("metrics: counters increment on events", () => {
  const m = createMetricsCollector()
  m.handleEvent(makeEvent(EVENT_TYPES.TURN_START))
  m.handleEvent(makeEvent(EVENT_TYPES.TURN_START))
  m.handleEvent(makeEvent(EVENT_TYPES.TURN_ERROR))
  m.handleEvent(makeEvent(EVENT_TYPES.TOOL_START))
  m.handleEvent(makeEvent(EVENT_TYPES.TOOL_START))
  m.handleEvent(makeEvent(EVENT_TYPES.TOOL_START))
  m.handleEvent(makeEvent(EVENT_TYPES.TOOL_ERROR))

  const snap = m.getSnapshot()
  assert.equal(snap.counters.get("turn_count"), 2)
  assert.equal(snap.counters.get("error_count"), 1)
  assert.equal(snap.counters.get("tool_call_count"), 3)
  assert.equal(snap.counters.get("tool_error_count"), 1)
})

test("metrics: token counters from TURN_USAGE_UPDATE", () => {
  const m = createMetricsCollector()
  m.handleEvent(makeEvent(EVENT_TYPES.TURN_USAGE_UPDATE, { input: 100, output: 50, cacheRead: 20 }))
  m.handleEvent(makeEvent(EVENT_TYPES.TURN_USAGE_UPDATE, { input: 200, output: 80 }))

  const snap = m.getSnapshot()
  assert.equal(snap.counters.get("token_input"), 300)
  assert.equal(snap.counters.get("token_output"), 130)
  assert.equal(snap.counters.get("token_cache_read"), 20)
})

test("metrics: histogram percentile calculation", () => {
  const m = createMetricsCollector()
  const base = Date.now()
  // Simulate 5 turns with known durations
  const durations = [10, 20, 30, 40, 100]
  for (let i = 0; i < durations.length; i++) {
    const turnId = `turn_${i}`
    m.handleEvent(makeEvent(EVENT_TYPES.TURN_START, {}, { turnId, timestamp: base }))
    m.handleEvent(makeEvent(EVENT_TYPES.TURN_FINISH, {}, { turnId, timestamp: base + durations[i] }))
  }

  const snap = m.getSnapshot()
  const h = snap.histograms.get("turn_duration_ms")
  assert.ok(h)
  assert.equal(h.count, 5)
  assert.equal(h.sum, 200)
  assert.equal(h.min, 10)
  assert.equal(h.max, 100)
  assert.equal(h.avg, 40)
  assert.ok(h.p50 >= 20 && h.p50 <= 30)
  assert.ok(h.p99 >= 40)
})

test("tracer: creates span from turn event pair", () => {
  const t = createTracer()
  const base = Date.now()
  t.handleEvent(makeEvent(EVENT_TYPES.TURN_START, {}, { turnId: "t1", timestamp: base }))
  t.handleEvent(makeEvent(EVENT_TYPES.TURN_FINISH, {}, { turnId: "t1", timestamp: base + 50 }))

  const traces = t.getTraces()
  assert.equal(traces.length, 1)
  assert.equal(traces[0].name, "turn")
  assert.equal(traces[0].status, "ok")
  assert.equal(traces[0].duration, 50)
  assert.ok(traces[0].traceId)
  assert.ok(traces[0].spanId)
})

test("tracer: turn error creates error span", () => {
  const t = createTracer()
  const base = Date.now()
  t.handleEvent(makeEvent(EVENT_TYPES.TURN_START, {}, { turnId: "t2", timestamp: base }))
  t.handleEvent(makeEvent(EVENT_TYPES.TURN_ERROR, { error: "boom" }, { turnId: "t2", timestamp: base + 30 }))

  const traces = t.getTraces()
  assert.equal(traces.length, 1)
  assert.equal(traces[0].status, "error")
  assert.equal(traces[0].attributes.error, "boom")
})

test("tracer: exportTraces returns valid JSON", () => {
  const t = createTracer()
  t.handleEvent(makeEvent(EVENT_TYPES.TURN_START, {}, { turnId: "t3" }))
  t.handleEvent(makeEvent(EVENT_TYPES.TURN_FINISH, {}, { turnId: "t3" }))

  const json = t.exportTraces("json")
  const parsed = JSON.parse(json)
  assert.ok(Array.isArray(parsed))
  assert.equal(parsed.length, 1)
})

test("metrics: reset clears all state", () => {
  const m = createMetricsCollector()
  m.handleEvent(makeEvent(EVENT_TYPES.TURN_START))
  m.handleEvent(makeEvent(EVENT_TYPES.TOOL_START))

  let snap = m.getSnapshot()
  assert.equal(snap.counters.get("turn_count"), 1)

  m.reset()
  snap = m.getSnapshot()
  assert.equal(snap.counters.size, 0)
  assert.equal(snap.histograms.size, 0)
})

test("tracer: reset clears all traces", () => {
  const t = createTracer()
  t.handleEvent(makeEvent(EVENT_TYPES.TURN_START, {}, { turnId: "t4" }))
  t.handleEvent(makeEvent(EVENT_TYPES.TURN_FINISH, {}, { turnId: "t4" }))
  assert.equal(t.getTraces().length, 1)

  t.reset()
  assert.equal(t.getTraces().length, 0)
})

test("initialize/shutdown lifecycle", async () => {
  // Before initialize, getMetrics returns null
  shutdown() // ensure clean state
  assert.equal(getMetrics(), null)
  assert.deepEqual(getTraces(), [])

  initialize(EventBus)

  // Emit an event through EventBus — observability should capture it
  await EventBus.emit({
    type: EVENT_TYPES.TURN_START,
    sessionId: "ses_lifecycle",
    turnId: "turn_lifecycle",
    payload: {}
  })

  const metrics = getMetrics()
  assert.ok(metrics)
  assert.equal(metrics.counters.get("turn_count"), 1)

  const traces = getTraces()
  // turn_start opens a span but doesn't close it, so no completed traces yet
  assert.equal(traces.length, 0)

  const report = exportReport()
  assert.ok(report.metrics)
  assert.ok(report.traces)

  shutdown()
  assert.equal(getMetrics(), null)
})
