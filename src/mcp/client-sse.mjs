import { McpError } from "../core/errors.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { normalizeToolResult } from "./tool-result.mjs"
import { MCP_PROTOCOL_VERSION, MCP_CLIENT_INFO } from "./constants.mjs"

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

  async function sendRequest(method, params = {}, { signal: parentSignal = null } = {}) {
    if (nextId > Number.MAX_SAFE_INTEGER - 1) nextId = 1
    const id = nextId++
    const body = { jsonrpc: "2.0", id, method, params }
    const startedAt = Date.now()

    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const combinedSignal = parentSignal
      ? AbortSignal.any([parentSignal, timeoutSignal])
      : timeoutSignal

    try {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify(body),
        signal: combinedSignal
      })

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
      const json = await res.json().catch((parseErr) => {
        throw new McpError(
          `mcp server "${serverName}" malformed JSON in ${method} response: ${parseErr.message}`,
          { reason: "bad_response", server: serverName, action: method, phase: "request" }
        )
      })
      if (json.error) {
        throw new McpError(
          `mcp server "${serverName}" error: ${json.error.message || JSON.stringify(json.error)}`,
          { reason: "bad_response", server: serverName, action: method, code: json.error.code, phase: "request" }
        )
      }
      return json.result ?? json
    } catch (error) {
      if (error instanceof McpError) throw error
      const reason = (error.name === "AbortError" || error.name === "TimeoutError") ? "timeout" : "connection_refused"
      throw new McpError(
        `mcp server "${serverName}" ${reason}: ${error.message}`,
        { reason, server: serverName, action: method, phase: "request" }
      )
    }
  }

  const maxSseBufferBytes = Number(config.max_sse_buffer_bytes || 4 * 1024 * 1024)

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
        if (Buffer.byteLength(buffer, "utf8") > maxSseBufferBytes) {
          try { reader.releaseLock() } catch {}
          throw new McpError(
            `mcp server "${serverName}" SSE buffer exceeded ${maxSseBufferBytes} bytes`,
            { reason: "bad_response", server: serverName, phase: "request" }
          )
        }

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
      else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trim()
    }
    if (!data) return null
    return { event, data }
  }

  async function ensureInitialized() {
    if (initialized) return
    let result
    try {
      result = await sendRequest("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: MCP_CLIENT_INFO
      })
    } catch (err) {
      initialized = false
      throw err
    }
    // Send initialized notification
    try {
      await fetch(baseUrl, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        signal: AbortSignal.timeout(timeoutMs)
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
      const result = await sendRequest("tools/call", { name, arguments: args }, { signal })
      return normalizeToolResult(result, serverName, name)
    },

    shutdown() {
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
