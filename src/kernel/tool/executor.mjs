import { makeToolResult, isToolSuccess } from "../core/types.mjs"
import { toolResultContent } from './result-content.mjs'

import { EventBus } from "../core/events.mjs"
import { validateToolArguments } from './validate-args.mjs'
import { snapshotToolArguments } from './schema-validation.mjs'
import { EVENT_TYPES } from "../core/constants.mjs"
import { withAudit } from "./audit-wrapper.mjs"
import { autoSnapshotBeforeEdit } from "../session/checkpoint.mjs"
import { buildMutationObservability } from "../../observability/edit-diagnostics.mjs"
import { toolCapability } from '../permission/rules.mjs'
import { beginToolOperation } from './operation-journal.mjs'
import { currentDurableRun } from '../orchestration/run-runtime.mjs'

const FILE_EDIT_TOOLS = new Set(["write", "edit", "multiedit", "patch", "notebookedit", "move", "copy", "remove", "mkdir", "archive", "git_apply_patch"])
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
  // Freeze wire-equivalent values before the first await/audit callback. Never
  // validate one mutable object and execute a later changed version of it.
  try { args = snapshotToolArguments(args) }
  catch (error) { return makeToolResult({ name: tool.name, status: 'error', ok: false, code: error.code, output: error.message, error: error.message }) }
  const durableRun = currentDurableRun()
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
      let operation
      let durableOperation
      let effectStarted = false
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

        // Bad arguments must not trigger snapshots or any tool-side work.
        if (args?.__parse_error === true) throw Object.assign(new Error(`Invalid JSON arguments for ${tool.name}; resend one complete JSON object matching the tool schema. No tool action was executed.`), { code: 'invalid_tool_call_json' })
        await validateToolArguments(tool, args || {}, { signal })

        // Auto snapshot before first file edit per turn
        if (FILE_EDIT_TOOLS.has(tool.name) && !durableRun) {
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

        const capability = tool.capabilityFor?.(args) || toolCapability(tool.name, String(args?.command || ''))
        if (durableRun) durableOperation = await durableRun.prepareTool({ tool, args: args || {}, invocationId: toolInvocationId, sessionId, turnId, capability })
        else if (!['read', 'search', 'safe-shell'].includes(capability) && !['tool_batch', 'websearch', 'webfetch', 'codesearch'].includes(tool.name)) operation = await beginToolOperation({ sessionId, turnId, tool: tool.name, args: args || {} })
        effectStarted = true
        const raw = durableRun
          ? await durableRun.executeTool({ tool, args: args || {}, context, signal, invoke: () => tool.execute(args || {}, context) })
          : await tool.execute(args || {}, context)
        const normalizedContent = await toolResultContent(raw, rawOutput(raw))
        const output = normalizedContent.output
        const metadata = raw?.metadata && typeof raw.metadata === "object" ? { ...raw.metadata } : {}
        const status = rawStatus(raw, signal, output)
        if (status === 'cancelled' && (operation || durableOperation?.effect !== 'read' && durableOperation)) metadata.outcomeUnknown = true
        await operation?.finish(status === 'cancelled' || metadata.outcomeUnknown === true ? 'uncertain' : 'settled')
        operation = null
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
          image: normalizedContent.contentBlocks.find(block => block.type === 'image') || null,
          contentBlocks: normalizedContent.contentBlocks
        })
        if (durableOperation) {
          await durableRun.settleTool({ operation: durableOperation, result })
          durableOperation = null
        }
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
        const outcomeUnknown = effectStarted && error.operationNotStarted !== true && error.code !== 'workspace_path_violation' && Boolean(operation || durableOperation && durableOperation.effect !== 'read')
        if (durableOperation) {
          try { await durableRun.failTool({ operation: durableOperation, error, effectStarted }) }
          catch (storageError) { durableRun.abort(storageError) }
        } else if (durableRun && ['STALE_OWNER', 'REVISION_CONFLICT', 'ACTION_UNRESOLVED', 'STORE_OUTCOME_UNKNOWN', 'STORE_CLOSED'].includes(error.code)) durableRun.abort(error)
        await operation?.finish(error.operationNotStarted === true || error.code === 'workspace_path_violation' ? 'settled' : 'uncertain').catch(() => {})
        const errorMessage = error?.message || String(error)
        const cancelled = signal?.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR"
        const result = makeToolResult({
          name: tool.name,
          status: cancelled ? "cancelled" : "error",
          ok: false,
          code: error?.code || (cancelled ? "cancelled" : null),
          output: errorMessage,
          error: errorMessage,
          durationMs: Date.now() - startedAt,
          ...(outcomeUnknown ? { metadata: { outcomeUnknown: true } } : {})
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
