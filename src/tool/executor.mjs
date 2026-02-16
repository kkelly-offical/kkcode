import { makeToolResult } from "../core/types.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { withAudit } from "./audit-wrapper.mjs"

export async function executeTool({ tool, args, sessionId, turnId, context, signal = null }) {
  return withAudit({
    sessionId,
    turnId,
    toolName: tool.name,
    args,
    run: async () => {
      const startedAt = Date.now()
      await EventBus.emit({
        type: EVENT_TYPES.TOOL_START,
        sessionId,
        turnId,
        payload: {
          tool: tool.name,
          args
        }
      })

      try {
        if (signal?.aborted) {
          const cancelled = makeToolResult({
            name: tool.name,
            status: "cancelled",
            output: "tool cancelled before execution",
            durationMs: Date.now() - startedAt
          })
          await EventBus.emit({
            type: EVENT_TYPES.TOOL_ERROR,
            sessionId,
            turnId,
            payload: {
              tool: tool.name,
              status: cancelled.status,
              output: cancelled.output,
              args,
              durationMs: cancelled.durationMs
            }
          })
          return cancelled
        }

        const raw = await tool.execute(args || {}, context)
        let output = ""
        let metadata = {}
        if (typeof raw === "string") {
          output = raw
        } else if (raw && typeof raw === "object") {
          if (typeof raw.output === "string") {
            output = raw.output
          } else {
            output = JSON.stringify(raw, null, 2)
          }
          if (raw.metadata && typeof raw.metadata === "object") {
            metadata = raw.metadata
          }
        } else {
          output = String(raw ?? "")
        }
        const result = makeToolResult({
          name: tool.name,
          status: "completed",
          output,
          durationMs: Date.now() - startedAt,
          metadata
        })
        await EventBus.emit({
          type: EVENT_TYPES.TOOL_FINISH,
          sessionId,
          turnId,
          payload: {
            tool: tool.name,
            status: result.status,
            args,
            output: String(output || "").slice(0, 500),
            durationMs: result.durationMs
          }
        })
        return result
      } catch (error) {
        const errorMessage = error?.message || String(error)
        const result = makeToolResult({
          name: tool.name,
          status: "error",
          output: errorMessage,
          error: errorMessage,
          durationMs: Date.now() - startedAt
        })
        await EventBus.emit({
          type: EVENT_TYPES.TOOL_ERROR,
          sessionId,
          turnId,
          payload: {
            tool: tool.name,
            status: result.status,
            error: result.error,
            args,
            durationMs: result.durationMs
          }
        })
        return result
      }
    }
  })
}
