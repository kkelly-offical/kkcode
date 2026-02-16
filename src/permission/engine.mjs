import { PermissionError } from "../core/errors.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { EventBus } from "../core/events.mjs"
import { evaluatePermission } from "./rules.mjs"
import { askPermissionInteractive } from "./prompt.mjs"

const sessionAllow = new Map()

function cacheKey(tool, pattern) {
  return `${tool}::${pattern || "*"}`
}

export const PermissionEngine = {
  clearSession(sessionId) {
    sessionAllow.delete(sessionId)
  },
  listSession(sessionId) {
    return [...(sessionAllow.get(sessionId) || new Set())]
  },
  async check({ config, sessionId, tool, mode, pattern = "*", command = "", risk = 0, reason = "" }) {
    const key = cacheKey(tool, pattern)
    const set = sessionAllow.get(sessionId)
    if (set?.has(key)) {
      await EventBus.emit({
        type: EVENT_TYPES.PERMISSION_DECIDED,
        sessionId,
        payload: { tool, decision: "allow_session", source: "cache" }
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
      return { decision: "allow_once", granted: true }
    }
    if (decision.action === "deny") {
      await EventBus.emit({
        type: EVENT_TYPES.PERMISSION_DECIDED,
        sessionId,
        payload: { tool, decision: "deny", source: decision.source }
      })
      throw new PermissionError(`permission denied for tool ${tool}`)
    }

    await EventBus.emit({
      type: EVENT_TYPES.PERMISSION_ASKED,
      sessionId,
      payload: { tool, mode, pattern, reason, risk }
    })
    const reply = await askPermissionInteractive({
      tool,
      sessionId,
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
      return { decision: "allow_session", granted: true }
    }
    if (reply === "allow_once") {
      await EventBus.emit({
        type: EVENT_TYPES.PERMISSION_DECIDED,
        sessionId,
        payload: { tool, decision: "allow_once", source: "interactive" }
      })
      return { decision: "allow_once", granted: true }
    }

    await EventBus.emit({
      type: EVENT_TYPES.PERMISSION_DECIDED,
      sessionId,
      payload: { tool, decision: "deny", source: "interactive" }
    })
    throw new PermissionError(`permission denied for tool ${tool}`)
  }
}
