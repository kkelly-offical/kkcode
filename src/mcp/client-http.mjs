import { McpError } from "../core/errors.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { normalizeToolResult } from "./tool-result.mjs"

function timeoutSignal(ms, parentSignal = null) {
  const own = AbortSignal.timeout(ms)
  if (!parentSignal) return own
  return AbortSignal.any([parentSignal, own])
}

function classifyHttpError(error, status = null) {
  const msg = String(error?.message || error || "")
  if (msg.includes("AbortError") || msg.includes("timeout") || msg.includes("abort")) return "timeout"
  if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) return "connection_refused"
  if (status && status >= 500) return "server_crash"
  if (status && status >= 400) return "bad_response"
  return "unknown"
}

async function requestJson({ serverName, method, url, body = null, timeoutMs = 10000, headers = {}, signal = null }) {
  const action = method === "GET" ? url.split("/").pop() : body?.args ? "call_tool" : "request"
  const startedAt = Date.now()
  let status = null

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: timeoutSignal(timeoutMs, signal)
    })

    status = res.status
    const elapsed = Date.now() - startedAt

    EventBus.emit({
      type: EVENT_TYPES.MCP_REQUEST,
      payload: { server: serverName, action, method, elapsed, status }
    }).catch(() => {})

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      const reason = classifyHttpError(null, status)
      throw new McpError(
        `mcp server "${serverName}" HTTP ${status} on ${method} ${url}: ${text.slice(0, 500)}`,
        { reason, server: serverName, action, phase: "request", statusCode: status }
      )
    }
    return res.json().catch((parseErr) => {
      throw new McpError(
        `mcp server "${serverName}" malformed JSON response: ${parseErr.message}`,
        { reason: "bad_response", server: serverName, action: body?.method || "request", phase: "request" }
      )
    })
  } catch (error) {
    if (error instanceof McpError) throw error
    const reason = classifyHttpError(error, status)
    throw new McpError(
      `mcp server "${serverName}" ${reason} on ${method} ${url}: ${error.message}`,
      { reason, server: serverName, action, phase: "request", statusCode: status }
    )
  }
}

export function createHttpMcpClient(serverName, config) {
  const baseUrl = String(config.url || "").replace(/\/$/, "")
  const timeoutMs = Number(config.timeout_ms || 10000)
  const headers = config.headers || {}

  return {
    serverName,
    transport: "http",
    async health() {
      try {
        await requestJson({ serverName, method: "GET", url: `${baseUrl}/health`, timeoutMs, headers })
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error.message, reason: error.reason || "unknown" }
      }
    },
    async listTools() {
      const out = await requestJson({ serverName, method: "GET", url: `${baseUrl}/tools`, timeoutMs, headers })
      return Array.isArray(out?.tools) ? out.tools : []
    },
    async listPrompts() {
      try {
        const out = await requestJson({ serverName, method: "GET", url: `${baseUrl}/prompts`, timeoutMs, headers })
        return Array.isArray(out?.prompts) ? out.prompts : []
      } catch {
        return []
      }
    },
    async getPrompt(name, args = {}) {
      return requestJson({
        serverName,
        method: "POST",
        url: `${baseUrl}/prompts/${encodeURIComponent(name)}`,
        body: { arguments: args },
        timeoutMs,
        headers
      })
    },
    async listResources() {
      try {
        const out = await requestJson({ serverName, method: "GET", url: `${baseUrl}/resources`, timeoutMs, headers })
        return Array.isArray(out?.resources) ? out.resources : []
      } catch {
        return []
      }
    },
    async listTemplates() {
      try {
        const out = await requestJson({ serverName, method: "GET", url: `${baseUrl}/templates`, timeoutMs, headers })
        return Array.isArray(out?.templates) ? out.templates : []
      } catch {
        return []
      }
    },
    async callTool(name, args = {}, signal = null) {
      const result = await requestJson({
        serverName,
        method: "POST",
        url: `${baseUrl}/tools/${encodeURIComponent(name)}`,
        body: { arguments: args },
        timeoutMs,
        headers,
        signal
      })
      return normalizeToolResult(result, serverName, name)
    },
    shutdown() {
      // HTTP client is stateless — no persistent connections to clean up
    }
  }
}
