import { createMetricsCollector } from "./metrics.mjs"
import { createTracer } from "./tracer.mjs"

let metrics = null
let tracer = null
let unsubscribes = []

export function initialize(eventBus) {
  if (metrics) return // idempotent

  metrics = createMetricsCollector()
  tracer = createTracer()

  unsubscribes.push(
    eventBus.registerSink(async (event) => {
      metrics.handleEvent(event)
      tracer.handleEvent(event)
    })
  )
}

export function shutdown() {
  for (const unsub of unsubscribes) unsub()
  unsubscribes = []
  metrics = null
  tracer = null
}

export function getMetrics() {
  return metrics ? metrics.getSnapshot() : null
}

export function getTraces() {
  return tracer ? tracer.getTraces() : []
}

export function exportReport() {
  return {
    metrics: metrics ? metrics.getSnapshot() : null,
    traces: tracer ? tracer.exportTraces("json") : "[]"
  }
}
