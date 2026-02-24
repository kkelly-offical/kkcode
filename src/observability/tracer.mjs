import { EVENT_TYPES } from "../core/constants.mjs"
import { randomUUID } from "node:crypto"

function newSpanId() {
  return `span_${randomUUID().slice(0, 12)}`
}

export function createTracer(options = {}) {
  const maxTraces = options.maxTraces || 100
  const traces = []
  const openSpans = new Map()
  const phaseSpan = { current: null }
  let currentTraceId = null

  function startSpan(name, attributes = {}, parentSpanId = null, timestamp = null) {
    if (!currentTraceId) currentTraceId = `trace_${randomUUID().slice(0, 12)}`
    const span = {
      traceId: currentTraceId,
      spanId: newSpanId(),
      parentSpanId,
      name,
      startTime: timestamp || Date.now(),
      endTime: null,
      duration: null,
      attributes,
      status: "ok"
    }
    return span
  }

  function closeSpan(span, status = "ok", timestamp = null) {
    span.endTime = timestamp || Date.now()
    span.duration = span.endTime - span.startTime
    span.status = status
    traces.push(span)
    if (traces.length > maxTraces) traces.shift()
  }

  function handleEvent(event) {
    const { type, payload, turnId, sessionId, timestamp } = event

    if (type === EVENT_TYPES.TURN_START) {
      const span = startSpan("turn", { turnId, sessionId }, null, timestamp)
      if (turnId) openSpans.set(`turn:${turnId}`, span)
    }

    if (type === EVENT_TYPES.TURN_FINISH) {
      const key = `turn:${turnId}`
      const span = openSpans.get(key)
      if (span) {
        closeSpan(span, "ok", timestamp)
        openSpans.delete(key)
      }
    }

    if (type === EVENT_TYPES.TURN_ERROR) {
      const key = `turn:${turnId}`
      const span = openSpans.get(key)
      if (span) {
        span.attributes.error = payload?.error || "unknown"
        closeSpan(span, "error", timestamp)
        openSpans.delete(key)
      }
    }

    if (type === EVENT_TYPES.LONGAGENT_STAGE_STARTED) {
      const stageId = payload?.stageId
      if (stageId) {
        const span = startSpan("stage", { stageId, sessionId }, null, timestamp)
        openSpans.set(`stage:${stageId}`, span)
      }
    }

    if (type === EVENT_TYPES.LONGAGENT_STAGE_FINISHED) {
      const stageId = payload?.stageId
      const key = `stage:${stageId}`
      const span = openSpans.get(key)
      if (span) {
        span.attributes.successCount = payload?.successCount
        span.attributes.failCount = payload?.failCount
        closeSpan(span, payload?.allSuccess ? "ok" : "error", timestamp)
        openSpans.delete(key)
      }
    }

    if (type === EVENT_TYPES.LONGAGENT_PHASE_CHANGED) {
      if (phaseSpan.current) {
        closeSpan(phaseSpan.current, "ok", timestamp)
      }
      const span = startSpan("phase", {
        phase: payload?.phase || payload?.newPhase,
        sessionId
      }, null, timestamp)
      phaseSpan.current = span
    }
  }

  function getTraces() {
    return [...traces]
  }

  function exportTraces(format = "json") {
    if (format === "json") return JSON.stringify(traces, null, 2)
    return JSON.stringify(traces)
  }

  function reset() {
    traces.length = 0
    openSpans.clear()
    phaseSpan.current = null
    currentTraceId = null
  }

  return { handleEvent, getTraces, exportTraces, reset }
}
