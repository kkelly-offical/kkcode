import { randomUUID } from "node:crypto"

export function nowMs() {
  return Date.now()
}

export function newId(prefix) {
  return `${prefix}_${randomUUID().slice(0, 12)}`
}

export function makeEventEnvelope({ type, sessionId = null, turnId = null, payload = {} }) {
  return {
    id: newId("evt"),
    type,
    sessionId,
    turnId,
    timestamp: nowMs(),
    payload
  }
}

export function makeToolResult({ name, status, output = "", error = null, durationMs = 0, metadata = {} }) {
  return {
    name,
    status,
    output,
    error,
    durationMs,
    metadata
  }
}

export function makeTurnResult({
  sessionId,
  turnId,
  mode,
  model,
  reply,
  usage,
  cost,
  toolEvents,
  estimated = false,
  warnings = []
}) {
  return {
    sessionId,
    turnId,
    mode,
    model,
    reply,
    usage,
    cost,
    toolEvents,
    estimated,
    warnings
  }
}
