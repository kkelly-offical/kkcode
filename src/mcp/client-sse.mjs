import { McpError } from "../core/errors.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"

/**
 * MCP Streamable HTTP (SSE) client.
 *
 * Protocol: JSON-RPC 2.0 over HTTP POST with optional SSE response streaming.
 * - POST to endpoint: send JSON-RPC request, receive JSON or SSE stream
 * - GET to endpoint: open persistent SSE stream for server-initiated notifications
 * - Session management via Mcp-Session-Id header
 */
export function createSseMcpClient(serverName, config) {
  const baseUrl = String(config.url || "").replace(/\/$/, "")
  const timeoutMs = Number(config.timeout_ms || 30000)
  const headers = config.headers || {}

  let sessionId = null
  let nextId = 1
  let initialized = false
  let notificationStream = null

  function normalizeToolResult(result, toolName) {
    if (result?.isError) {
      const text = Array.isArray(result.content)
        ? result.content.map((item) => item?.text || "").join("\n").trim()
        : ""
      throw new McpError(text || "mcp tool returned isError", {
        reason: "bad_response",
        server: serverName,
        action: `tools/call:${toolName}`,
        phase: "request"
      })
    }
    const content = Array.isArray(result?.content) ? result.content : null
    const contentText = content
      ? content.map((item) => (typeof item?.text === "string" ? item.text : "")).join("\n").trim()
      : ""
    const output =
      contentText ||
      (typeof result?.output === "string" ? result.output : "") ||
      (typeof result === "string" ? result : JSON.stringify(result))
    return content ? { output, raw: result, content } : { output, raw: result }
  }

  function buildHeaders(extra = {}) {
    const h = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
      ...extra
    }
    if (sessionId) h["mcp-session-id"] = sessionId
    return h
  }

  async function sendRequest(method, params = {}) {
    const id = nextId++
    const body = { jsonrpc: "2.0", id, method, params }
    const startedAt = Date.now()

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal
      })

      clearTimeout(timer)
      const elapsed = Date.now() - startedAt

      // Capture session ID from response
      const newSessionId = res.headers.get("mcp-session-id")
      if (newSessionId) sessionId = newSessionId

      EventBus.emit({
        type: EVENT_TYPES.MCP_REQUEST,
        payload: { server: serverName, action: method, elapsed, status: res.status }
      }).catch(() => {})

      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new McpError(
          `mcp server "${serverName}" HTTP ${res.status}: ${text.slice(0, 500)}`,
          {
            reason: res.status >= 500 ? "server_crash" : "bad_response",
            server: serverName,
            action: method,
            phase: "request",
            statusCode: res.status
          }
        )
      }

      const contentType = res.headers.get("content-type") || ""

      // SSE response — parse events and return the final result
      if (contentType.includes("text/event-stream")) {
        return await parseSseResponse(res.body, id)
      }

      // Regular JSON response
      const json = await res.json().catch(() => ({}))
      if (json.error) {
        throw new McpError(
          `mcp server "${serverName}" error: ${json.error.message || JSON.stringify(json.error)}`,
          { reason: "bad_response", server: serverName, action: method, code: json.error.code, phase: "request" }
        )
      }
      return json.result ?? json
    } catch (error) {
      clearTimeout(timer)
      if (error instanceof McpError) throw error
      const reason = error.name === "AbortError" ? "timeout" : "connection_refused"
      throw new McpError(
        `mcp server "${serverName}" ${reason}: ${error.message}`,
        { reason, server: serverName, action: method, phase: "request" }
      )
    }
  }

  async function parseSseResponse(body, requestId) {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let result = null

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const parts = buffer.split("\n\n")
        buffer = parts.pop()

        for (const part of parts) {
          const event = parseSsePart(part)
          if (!event) continue

          try {
            const msg = JSON.parse(event.data)
            // Match our request ID
            if (msg.id === requestId) {
              if (msg.error) {
                throw new McpError(
                  `mcp server "${serverName}" error: ${msg.error.message || JSON.stringify(msg.error)}`,
                  { reason: "bad_response", server: serverName, code: msg.error.code, phase: "request" }
                )
              }
              result = msg.result ?? msg
            }
            // Server notifications — emit as events
            if (!msg.id && msg.method) {
              EventBus.emit({
                type: EVENT_TYPES.MCP_REQUEST,
                payload: { server: serverName, action: `notification:${msg.method}`, notification: true }
              }).catch(() => {})
            }
          } catch (e) {
            if (e instanceof McpError) throw e
            // Non-JSON SSE data — skip
          }
        }
      }
    } finally {
      try { reader.releaseLock() } catch { /* reader may have pending read if stream was force-closed */ }
    }

    return result ?? {}
  }

  function parseSsePart(part) {
    const trimmed = part.trim()
    if (!trimmed) return null
    let event = null
    let data = ""
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim()
      else if (line.startsWith("data:")) data += line.slice(5).trim()
    }
    if (!data) return null
    return { event, data }
  }

  async function ensureInitialized() {
    if (initialized) return
    const result = await sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "kkcode", version: "0.1.2" }
    })
    // Send initialized notification
    try {
      await fetch(baseUrl, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
      })
    } catch { /* best-effort */ }
    initialized = true
    return result
  }

  return {
    serverName,
    transport: "sse",

    async health() {
      try {
        await ensureInitialized()
        await sendRequest("ping")
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error.message, reason: error.reason || "unknown" }
      }
    },

    async listTools() {
      await ensureInitialized()
      const out = await sendRequest("tools/list")
      return Array.isArray(out?.tools) ? out.tools : []
    },

    async listPrompts() {
      await ensureInitialized()
      try {
        const out = await sendRequest("prompts/list")
        return Array.isArray(out?.prompts) ? out.prompts : []
      } catch {
        return []
      }
    },

    async getPrompt(name, args = {}) {
      await ensureInitialized()
      return sendRequest("prompts/get", { name, arguments: args })
    },

    async listResources() {
      await ensureInitialized()
      try {
        const out = await sendRequest("resources/list")
        return Array.isArray(out?.resources) ? out.resources : []
      } catch {
        return []
      }
    },

    async listTemplates() {
      await ensureInitialized()
      try {
        const out = await sendRequest("resources/templates/list")
        return Array.isArray(out?.templates) ? out.templates : []
      } catch {
        return []
      }
    },

    async callTool(name, args = {}, signal = null) {
      await ensureInitialized()
      const result = await sendRequest("tools/call", { name, arguments: args })
      return normalizeToolResult(result, name)
    },

    shutdown() {
      if (notificationStream) {
        try { notificationStream.cancel() } catch { /* ignore */ }
        notificationStream = null
      }
      // Send session termination if we have a session
      if (sessionId) {
        fetch(baseUrl, {
          method: "DELETE",
          headers: buildHeaders()
        }).catch(() => {})
      }
      sessionId = null
      initialized = false
    }
  }
}
