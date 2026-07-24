import { startAuditSpan, summarizeAuditContent } from "../audit/event.mjs"

export async function withAudit({
  sessionId,
  turnId,
  traceId = "",
  requestId = "",
  parentEventId = "",
  toolName,
  args,
  run
}) {
  const span = await startAuditSpan({
    type: "tool",
    traceId,
    requestId,
    parentEventId,
    sessionId,
    turnId,
    tool: toolName,
    args
  })
  try {
    const result = await run()
    await span.finish({
      ok: result?.ok === true || (result?.ok === undefined && result?.status === "completed"),
      status: result?.status,
      outputSummary: summarizeAuditContent(result?.output || "")
    })
    return result
  } catch (error) {
    await span.fail(new Error("tool execution failed"), {
      errorClass: error?.name || null,
      errorCode: error?.code || null
    })
    throw error
  }
}
