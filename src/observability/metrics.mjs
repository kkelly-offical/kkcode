import { EVENT_TYPES } from "../core/constants.mjs"

function createHistogram() {
  const values = []
  return {
    record(v) { values.push(v) },
    snapshot() {
      if (values.length === 0) return { count: 0, sum: 0, min: 0, max: 0, avg: 0, p50: 0, p99: 0 }
      const sorted = [...values].sort((a, b) => a - b)
      const sum = sorted.reduce((s, v) => s + v, 0)
      const count = sorted.length
      return {
        count,
        sum,
        min: sorted[0],
        max: sorted[count - 1],
        avg: sum / count,
        p50: sorted[Math.max(0, Math.ceil(count * 0.5) - 1)] || 0,
        p99: sorted[Math.max(0, Math.ceil(count * 0.99) - 1)] || 0
      }
    },
    reset() { values.length = 0 }
  }
}

export function createMetricsCollector() {
  const counters = new Map()
  const histograms = new Map()
  const turnStarts = new Map()
  const stageStarts = new Map()

  function inc(name, amount = 1) {
    counters.set(name, (counters.get(name) || 0) + amount)
  }

  function hist(name) {
    if (!histograms.has(name)) histograms.set(name, createHistogram())
    return histograms.get(name)
  }

  const MAX_OPEN_ENTRIES = 500

  function pruneStaleMap(map) {
    if (map.size <= MAX_OPEN_ENTRIES) return
    const cutoff = Date.now() - 30 * 60 * 1000 // 30 min
    for (const [k, v] of map) {
      if (v < cutoff) map.delete(k)
    }
    // If still over limit, drop oldest half
    if (map.size > MAX_OPEN_ENTRIES) {
      let toDrop = Math.floor(map.size / 2)
      for (const k of map.keys()) {
        if (toDrop-- <= 0) break
        map.delete(k)
      }
    }
  }

  function handleEvent(event) {
    const { type, payload, turnId, sessionId } = event

    if (type === EVENT_TYPES.TURN_START) {
      inc("turn_count")
      if (turnId) {
        turnStarts.set(turnId, event.timestamp)
        pruneStaleMap(turnStarts)
      }
    }

    if (type === EVENT_TYPES.TURN_FINISH) {
      if (turnId && turnStarts.has(turnId)) {
        hist("turn_duration_ms").record(event.timestamp - turnStarts.get(turnId))
        turnStarts.delete(turnId)
      }
    }

    if (type === EVENT_TYPES.TURN_ERROR) {
      inc("error_count")
    }

    if (type === EVENT_TYPES.TOOL_START) {
      inc("tool_call_count")
    }

    if (type === EVENT_TYPES.TOOL_ERROR) {
      inc("tool_error_count")
    }

    if (type === EVENT_TYPES.TURN_USAGE_UPDATE) {
      if (payload?.input) inc("token_input", payload.input)
      if (payload?.output) inc("token_output", payload.output)
      if (payload?.cacheRead) inc("token_cache_read", payload.cacheRead)
    }

    if (type === EVENT_TYPES.LONGAGENT_STAGE_STARTED) {
      const key = payload?.stageId || sessionId
      if (key) {
        stageStarts.set(key, event.timestamp)
        pruneStaleMap(stageStarts)
      }
    }

    if (type === EVENT_TYPES.LONGAGENT_STAGE_FINISHED) {
      const key = payload?.stageId || sessionId
      if (key && stageStarts.has(key)) {
        hist("longagent_stage_duration_ms").record(event.timestamp - stageStarts.get(key))
        stageStarts.delete(key)
      }
      if (payload?.retryCount > 0) {
        inc("longagent_task_retries", payload.retryCount)
      }
    }

    if (type === EVENT_TYPES.LONGAGENT_GATE_CHECKED) {
      inc("gate_check_count")
      if (payload?.status === "pass") inc("gate_pass_count")
    }
  }

  function getSnapshot() {
    const counterSnapshot = new Map(counters)
    const histogramSnapshot = new Map()
    for (const [name, h] of histograms) {
      histogramSnapshot.set(name, h.snapshot())
    }
    return { counters: counterSnapshot, histograms: histogramSnapshot }
  }

  function reset() {
    counters.clear()
    histograms.clear()
    turnStarts.clear()
    stageStarts.clear()
  }

  return { handleEvent, getSnapshot, reset }
}
