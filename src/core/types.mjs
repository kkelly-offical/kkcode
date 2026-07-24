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

const TOOL_RESULT_STATUSES = new Set(["completed", "error", "blocked", "cancelled"])

export function makeToolResult({
  name,
  status,
  ok,
  code = null,
  output = "",
  error = null,
  durationMs = 0,
  metadata = {},
  evidence = {}
}) {
  let normalizedStatus = TOOL_RESULT_STATUSES.has(status)
    ? status
    : ok === false
      ? "error"
      : "completed"
  if (ok === false && normalizedStatus === "completed") normalizedStatus = "error"
  const successful = normalizedStatus === "completed" && ok !== false
  return {
    name,
    ok: successful,
    status: successful ? "completed" : normalizedStatus,
    code,
    output,
    error,
    durationMs,
    metadata,
    evidence
  }
}

export function isToolSuccess(result) {
  return result?.ok === true || (result?.ok === undefined && result?.status === "completed")
}

export function toolStatusKind(result) {
  if (isToolSuccess(result)) return "completed"
  if (result?.status === "completed") return "error"
  return TOOL_RESULT_STATUSES.has(result?.status) ? result.status : "error"
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
