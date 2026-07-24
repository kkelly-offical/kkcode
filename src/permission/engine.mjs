import { PermissionError } from "../core/errors.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { EventBus } from "../core/events.mjs"
import { evaluatePermission } from "./rules.mjs"
import { askPermissionInteractive } from "./prompt.mjs"
import { safeAppendAuditEntry } from "../storage/audit-store.mjs"
import { sanitizeAuditMetadata, summarizeAuditContent } from "../audit/event.mjs"

const sessionAllow = new Map()
let workspaceTrusted = false

function cacheKey(tool, pattern) {
  return `${tool}::${pattern || "*"}`
}

async function auditPermission(type, context, payload) {
  const safePayload = {
    ...payload,
    ...(Object.prototype.hasOwnProperty.call(payload, "args")
      ? { args: summarizeAuditContent(payload.args) }
      : {}),
    ...(payload.command ? { command: summarizeAuditContent(payload.command) } : {}),
    ...(payload.reason ? { reason: summarizeAuditContent(payload.reason) } : {}),
    ...(context.tool === "bash" && payload.pattern
      ? { pattern: summarizeAuditContent(payload.pattern) }
      : {})
  }
  await safeAppendAuditEntry({
    type,
    sessionId: context.sessionId,
    turnId: context.turnId || null,
    traceId: context.traceId || null,
    requestId: context.requestId || null,
    reviewId: context.reviewId || null,
    tool: context.tool,
    ...sanitizeAuditMetadata(safePayload)
  })
}

export const PermissionEngine = {
  setTrusted(value) { workspaceTrusted = Boolean(value) },
  isTrusted() { return workspaceTrusted },
  clearSession(sessionId) {
    sessionAllow.delete(sessionId)
  },
  listSession(sessionId) {
    return [...(sessionAllow.get(sessionId) || new Set())]
  },
  async check({
    config,
    sessionId,
    turnId = "",
    traceId = "",
    requestId = "",
    reviewId = "",
    tool,
    mode,
    pattern = "*",
    command = "",
    args = {},
    risk = 0,
    reason = ""
  }) {
    if (!workspaceTrusted) throw new PermissionError("workspace not trusted — run /trust to enable tools")
    const auditContext = { sessionId, turnId, traceId, requestId, reviewId, tool }
    const key = cacheKey(tool, pattern)
    const set = sessionAllow.get(sessionId)
    if (set?.has(key)) {
      await EventBus.emit({
        type: EVENT_TYPES.PERMISSION_DECIDED,
        sessionId,
        payload: { tool, decision: "allow_session", source: "cache" }
      })
      await auditPermission("permission.decided", auditContext, {
        decision: "allow_session", source: "cache", mode, pattern, risk
      })
      return { decision: "allow_session", granted: true }
    }

    const decision = evaluatePermission({ config, tool, mode, pattern, command, risk })
    if (decision.action === "allow") {
      await EventBus.emit({
        type: EVENT_TYPES.PERMISSION_DECIDED,
        sessionId,
        payload: { tool, decision: "allow_once", source: decision.source }
      })
      await auditPermission("permission.decided", auditContext, {
        decision: "allow_once", source: decision.source, mode, pattern, risk
      })
      return { decision: "allow_once", granted: true }
    }
    if (decision.action === "deny") {
      await EventBus.emit({
        type: EVENT_TYPES.PERMISSION_DECIDED,
        sessionId,
        payload: { tool, decision: "deny", source: decision.source }
      })
      await auditPermission("permission.decided", auditContext, {
        decision: "deny", source: decision.source, mode, pattern, risk
      })
      throw new PermissionError(`permission denied for tool ${tool}`)
    }

    await EventBus.emit({
      type: EVENT_TYPES.PERMISSION_ASKED,
      sessionId,
      payload: { tool, mode, pattern, command, args, reason, risk }
    })
    await auditPermission("permission.asked", auditContext, {
      mode, pattern, command, args, reason, risk
    })
    const reply = await askPermissionInteractive({
      tool,
      sessionId,
      pattern,
      command,
      args,
      risk,
      reason,
      defaultAction: config.permission?.non_tty_default || "deny"
    })
    if (reply === "allow_session") {
      const next = sessionAllow.get(sessionId) || new Set()
      next.add(key)
      sessionAllow.set(sessionId, next)
      await EventBus.emit({
        type: EVENT_TYPES.PERMISSION_DECIDED,
        sessionId,
        payload: { tool, decision: "allow_session", source: "interactive" }
      })
      await auditPermission("permission.decided", auditContext, {
        decision: "allow_session", source: "interactive", mode, pattern, risk
      })
      return { decision: "allow_session", granted: true }
    }
    if (reply === "allow_once") {
      await EventBus.emit({
        type: EVENT_TYPES.PERMISSION_DECIDED,
        sessionId,
        payload: { tool, decision: "allow_once", source: "interactive" }
      })
      await auditPermission("permission.decided", auditContext, {
        decision: "allow_once", source: "interactive", mode, pattern, risk
      })
      return { decision: "allow_once", granted: true }
    }

    await EventBus.emit({
      type: EVENT_TYPES.PERMISSION_DECIDED,
      sessionId,
      payload: { tool, decision: "deny", source: "interactive" }
    })
    await auditPermission("permission.decided", auditContext, {
      decision: "deny", source: "interactive", mode, pattern, risk
    })
    throw new PermissionError(`permission denied for tool ${tool}`)
  }
}
