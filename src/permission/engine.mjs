import { PermissionError } from "../core/errors.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { EventBus } from "../core/events.mjs"
import { evaluatePermission } from "./rules.mjs"
import { askPermissionInteractive } from "./prompt.mjs"
import { safeAppendAuditEntry } from "../storage/audit-store.mjs"
import { sanitizeAuditMetadata, summarizeAuditContent } from "../audit/event.mjs"

const sessionAllow = new Map()
let workspaceTrusted = false
let persistGrantHandler = null

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
  /**
   * 注册「Always Allow」的落盘回调。引擎自身不做 IO，宿主（REPL / CLI）
   * 决定规则写到哪个配置文件，测试可注入假实现。
   */
  setPersistGrantHandler(handler) {
    persistGrantHandler = typeof handler === "function" ? handler : null
  },
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
    reason = "",
    workspace = ""
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

    const decision = evaluatePermission({ config, tool, mode, pattern, command, risk, workspace })
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
    if (reply === "allow_session" || reply === "allow_always") {
      const next = sessionAllow.get(sessionId) || new Set()
      next.add(key)
      sessionAllow.set(sessionId, next)

      let persisted = false
      if (reply === "allow_always" && persistGrantHandler) {
        try {
          persisted = Boolean(await persistGrantHandler({ tool, pattern, command, workspace }))
        } catch (err) {
          // 落盘失败不应中断本次调用：会话内授权已经生效
          console.error("[permission] persist grant failed:", err?.message || err)
        }
      }

      const outcome = reply === "allow_always" ? "allow_always" : "allow_session"
      await EventBus.emit({
        type: EVENT_TYPES.PERMISSION_DECIDED,
        sessionId,
        payload: { tool, decision: outcome, source: "interactive", persisted }
      })
      await auditPermission("permission.decided", auditContext, {
        decision: outcome, source: "interactive", mode, pattern, risk, persisted
      })
      return { decision: outcome, granted: true, persisted }
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
