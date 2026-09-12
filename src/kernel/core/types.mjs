import { randomUUID } from "node:crypto"

export function nowMs() {
  return Date.now()
}

export function newId(prefix) {
  return `${prefix}_${randomUUID().slice(0, 12)}`
}

export function makeEventEnvelope({
  type,
  sessionId = null,
  turnId = null,
  traceId = null,
  requestId = null,
  parentEventId = null,
  payload = {}
}) {
  return {
    id: newId("evt"),
    type,
    sessionId,
    turnId,
    traceId,
    requestId,
    parentEventId,
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
  evidence = {},
  image = null
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
    evidence,
    // 图片附件（{data, mediaType}）。此前 read 返回的 base64 在这里被白名单
    // 丢掉，模型只收到一行 `Image file: x.png (12345 bytes)` —— 而工具描述
    // 承诺「可视觉分析」。provider 层（anthropic.mjs / openai.mjs）早就支持
    // { type: "image", data, mediaType } 块，缺的一直只是这一段。
    image: image && image.data ? { data: String(image.data), mediaType: String(image.mediaType || "image/png") } : null
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
