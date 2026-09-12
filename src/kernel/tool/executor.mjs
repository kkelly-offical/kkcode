import { makeToolResult, isToolSuccess } from "../core/types.mjs"
/**
 * 从工具返回值里取出图片附件。
 *
 * read 返回的是 data URI（`data:image/png;base64,...`），而 provider 层要的是
 * 拆开的 { data, mediaType }。两种写法都接受：已拆开的直接用。
 */
function parseImagePayload(raw) {
  if (!raw || typeof raw !== "object") return null
  if (raw.image?.data) return { data: raw.image.data, mediaType: raw.image.mediaType || "image/png" }
  if (raw.type !== "image" || typeof raw.data !== "string") return null
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(raw.data)
  if (match) return { data: match[2], mediaType: match[1] }
  return { data: raw.data, mediaType: raw.mediaType || "image/png" }
}

import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { withAudit } from "./audit-wrapper.mjs"
import { autoSnapshotBeforeEdit } from "../session/checkpoint.mjs"
import { buildMutationObservability } from "../../observability/edit-diagnostics.mjs"

const FILE_EDIT_TOOLS = new Set(["write", "edit", "multiedit", "patch", "notebookedit"])
// 同一 turn 可能并行触发多个编辑工具。只记一个 boolean 会让第二个工具越过仍在
// 进行的快照，因此这里缓存 Promise：首个编辑创建，所有并发编辑都等待同一份。
const snapshotPromises = new Map()

function outputFailureStatus(output) {
  const text = String(output || "").trim()
  if (/^\[blocked\]/i.test(text)) return "blocked"
  if (/^(?:error:|\[search error\]|\[mcp error\b)/i.test(text)) return "error"
  return null
}

function rawStatus(raw, signal, output) {
  if (signal?.aborted || raw?.cancelled === true || raw?.status === "cancelled") return "cancelled"
  if (raw?.blocked === true || raw?.metadata?.blocked === true || raw?.status === "blocked") return "blocked"
  if (raw?.ok === false || raw?.status === "error" || raw?.status === "failed" || raw?.is_error === true || raw?.error) return "error"
  return outputFailureStatus(output) || "completed"
}

function rawOutput(raw) {
  if (typeof raw === "string") return raw
  if (!raw || typeof raw !== "object") return String(raw ?? "")
  if (typeof raw.output === "string") return raw.output
  if (typeof raw.message === "string") return raw.message
  if (typeof raw.error === "string") return raw.error
  return JSON.stringify(raw, null, 2)
}

function rawError(raw, status, output) {
  if (status === "completed") return null
  if (typeof raw?.error === "string") return raw.error
  if (raw?.error?.message) return raw.error.message
  return output || status
}

function eventMetadataSummary(metadata = {}) {
  const fileChanges = Array.isArray(metadata.fileChanges) ? metadata.fileChanges : []
  const rawMutations = [
    ...(metadata.mutation && typeof metadata.mutation === "object" ? [metadata.mutation] : []),
    ...(Array.isArray(metadata.mutations) ? metadata.mutations : [])
  ]
  let remainingPatchLines = 120
  const mutations = rawMutations.slice(0, 12).map((mutation) => ({
    operation: String(mutation.operation || ""),
    filePath: String(mutation.filePath || ""),
    addedLines: Number(mutation.addedLines || 0),
    removedLines: Number(mutation.removedLines || 0),
    structuredPatch: (Array.isArray(mutation.structuredPatch) ? mutation.structuredPatch : [])
      .slice(0, 12)
      .map((hunk) => {
        const lines = (Array.isArray(hunk.lines) ? hunk.lines : [])
          .slice(0, Math.max(0, remainingPatchLines))
          .map((line) => ({
            type: String(line?.type || "context"),
            text: String(line?.text || "").slice(0, 300)
          }))
        remainingPatchLines = Math.max(0, remainingPatchLines - lines.length)
        return {
          oldStart: Number(hunk.oldStart || 0),
          oldLineCount: Number(hunk.oldLineCount || 0),
          newStart: Number(hunk.newStart || 0),
          newLineCount: Number(hunk.newLineCount || 0),
          lines
        }
      })
  }))
  const observability = metadata.observability?.contract
    ? metadata.observability
    : buildMutationObservability(metadata)
  const diagnostics = metadata.diagnostics?.contract
    ? {
        summary: metadata.diagnostics.summary || null,
        currentCount: metadata.diagnostics.current?.count || 0,
        delta: metadata.diagnostics.delta
          ? {
              added: metadata.diagnostics.delta.added?.length || 0,
              resolved: metadata.diagnostics.delta.resolved?.length || 0,
              persisted: metadata.diagnostics.delta.persisted?.length || 0
            }
          : null
      }
    : null

  if (!fileChanges.length && !mutations.length && !observability?.changes?.length && !diagnostics) return null
  return { fileChanges, mutations, observability, diagnostics }
}

export async function executeTool({ tool, args, sessionId, turnId, invocationId = null, context, signal = null }) {
  const toolInvocationId = String(invocationId || `${turnId || "turn"}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`)
  return withAudit({
    sessionId,
    turnId,
    traceId: context?.traceId || "",
    requestId: context?.requestId || "",
    toolName: tool.name,
    args,
    run: async () => {
      const startedAt = Date.now()
      await EventBus.emit({
        type: EVENT_TYPES.TOOL_START,
        sessionId,
        turnId,
        payload: {
          invocationId: toolInvocationId,
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
              invocationId: toolInvocationId,
              tool: tool.name,
              status: cancelled.status,
              output: cancelled.output,
              args,
              durationMs: cancelled.durationMs
            }
          })
          return cancelled
        }

        // Auto snapshot before first file edit per turn
        if (FILE_EDIT_TOOLS.has(tool.name)) {
          const snapshotKey = [sessionId || "", context?.cwd || "", turnId || toolInvocationId].join("\0")
          let snapshotPromise = snapshotPromises.get(snapshotKey)
          if (!snapshotPromise) {
            snapshotPromise = autoSnapshotBeforeEdit(sessionId, context.cwd, context.config).then(
              (result) => {
                // A failed attempt must not permanently mark the turn as snapshotted.
                // Concurrent edits still share and await this attempt; a later edit may retry.
                if (result?.ok === false && snapshotPromises.get(snapshotKey) === snapshotPromise) {
                  snapshotPromises.delete(snapshotKey)
                }
                return result
              },
              () => {
                if (snapshotPromises.get(snapshotKey) === snapshotPromise) {
                  snapshotPromises.delete(snapshotKey)
                }
                return null
              }
            )
            snapshotPromises.set(snapshotKey, snapshotPromise)
            if (snapshotPromises.size > 200) {
              const oldest = snapshotPromises.keys().next().value
              if (oldest !== snapshotKey) snapshotPromises.delete(oldest)
            }
          }
          // 快照失败仍沿用既有策略：不阻断编辑；但无论成功失败，都必须在写入前落定，
          // 否则 fire-and-forget 会把工具执行后的状态误记成“修改前”。
          await snapshotPromise
        }

        const raw = await tool.execute(args || {}, context)
        const output = rawOutput(raw)
        const metadata = raw?.metadata && typeof raw.metadata === "object" ? raw.metadata : {}
        const status = rawStatus(raw, signal, output)
        const evidence = {
          ...(raw?.evidence && typeof raw.evidence === "object" ? raw.evidence : {}),
          ...(Array.isArray(metadata.fileChanges) ? { fileChanges: metadata.fileChanges } : {}),
          ...(metadata.exitCode !== undefined ? { exitCode: metadata.exitCode } : {}),
          ...(metadata.checks !== undefined ? { checks: metadata.checks } : {}),
          ...(metadata.hashes !== undefined ? { hashes: metadata.hashes } : {})
        }
        const result = makeToolResult({
          name: tool.name,
          status,
          ok: status === "completed",
          code: raw?.code || (typeof raw?.error === "string" ? raw.error : metadata.reason || null),
          output,
          error: rawError(raw, status, output),
          durationMs: Date.now() - startedAt,
          metadata,
          evidence,
          // read 的图片分支返回 { type:"image", data:"data:image/png;base64,..." }。
          // 这里拆成 provider 层要的 { data, mediaType } —— 0.7.0 之前这个值
          // 到 makeToolResult 就被白名单丢掉了。
          image: parseImagePayload(raw)
        })
        await EventBus.emit({
          type: isToolSuccess(result) ? EVENT_TYPES.TOOL_FINISH : EVENT_TYPES.TOOL_ERROR,
          sessionId,
          turnId,
          payload: {
            invocationId: toolInvocationId,
            tool: tool.name,
            status: result.status,
            args,
            output: String(output || "").slice(0, 500),
            durationMs: result.durationMs,
            metadata: eventMetadataSummary(metadata),
            ...(result.error ? { error: result.error } : {})
          }
        })
        return result
      } catch (error) {
        const errorMessage = error?.message || String(error)
        const cancelled = signal?.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR"
        const result = makeToolResult({
          name: tool.name,
          status: cancelled ? "cancelled" : "error",
          ok: false,
          code: error?.code || (cancelled ? "cancelled" : null),
          output: errorMessage,
          error: errorMessage,
          durationMs: Date.now() - startedAt
        })
        await EventBus.emit({
          type: EVENT_TYPES.TOOL_ERROR,
          sessionId,
          turnId,
          payload: {
            invocationId: toolInvocationId,
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
