import { appendAuditEntry } from "../storage/audit-store.mjs"

const REDACT_KEYS = new Set(["api_key", "apiKey", "token", "password", "secret", "credential", "authorization"])
const TRUNCATE_KEYS = new Set(["content", "new_string", "old_string"])
const TRUNCATE_LIMIT = 200

function redactArgs(args) {
  if (!args || typeof args !== "object") return args
  const out = {}
  for (const [k, v] of Object.entries(args)) {
    if (REDACT_KEYS.has(k)) { out[k] = "[REDACTED]" }
    else if (TRUNCATE_KEYS.has(k) && typeof v === "string" && v.length > TRUNCATE_LIMIT) {
      out[k] = v.slice(0, TRUNCATE_LIMIT) + `... (${v.length} chars)`
    } else { out[k] = v }
  }
  return out
}

export async function withAudit({ sessionId, turnId, toolName, args, run }) {
  const startedAt = Date.now()
  await appendAuditEntry({
    type: "tool.start",
    sessionId,
    turnId,
    tool: toolName,
    args: redactArgs(args)
  })
  try {
    const result = await run()
    await appendAuditEntry({
      type: "tool.finish",
      sessionId,
      turnId,
      tool: toolName,
      durationMs: Date.now() - startedAt,
      ok: result?.status !== "error" && result?.status !== "cancelled",
      status: result?.status,
      output: result?.output?.slice(0, 2000) || ""
    })
    return result
  } catch (error) {
    await appendAuditEntry({
      type: "tool.error",
      sessionId,
      turnId,
      tool: toolName,
      durationMs: Date.now() - startedAt,
      ok: false,
      status: "error",
      error: error.message
    })
    throw error
  }
}
