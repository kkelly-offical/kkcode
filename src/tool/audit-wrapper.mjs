import { appendAuditEntry } from "../storage/audit-store.mjs"

export async function withAudit({ sessionId, turnId, toolName, args, run }) {
  const startedAt = Date.now()
  await appendAuditEntry({
    type: "tool.start",
    sessionId,
    turnId,
    tool: toolName,
    args
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
