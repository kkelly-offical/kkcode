import { spawn } from "node:child_process"
import { McpError } from "../core/errors.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { createStdioFramingDecoder, encodeRpcMessage } from "./stdio-framing.mjs"
import { normalizeToolResult } from "./tool-result.mjs"
import { MCP_PROTOCOL_VERSION, MCP_CLIENT_INFO } from "./constants.mjs"

const VALID_FRAMING = new Set(["auto", "content-length", "newline"])
const VALID_HEALTH_METHOD = new Set(["auto", "ping", "tools_list"])

function normalizeFraming(value) {
  const framing = String(value || "auto").toLowerCase()
  return VALID_FRAMING.has(framing) ? framing : "auto"
}

function normalizeHealthMethod(value) {
  const method = String(value || "auto").toLowerCase()
  return VALID_HEALTH_METHOD.has(method) ? method : "auto"
}

function classifySpawnError(error) {
  const code = String(error?.code || "").toUpperCase()
  const msg = String(error?.message || error || "")
  if (code === "ENOENT" || code === "EACCES") return "spawn_failed"
  if (msg.includes("ENOENT") || msg.includes("EACCES") || msg.includes("spawn")) return "spawn_failed"
  return "unknown"
}

export function createStdioMcpClient(serverName, config = {}) {
  const command = config.command
  const cmdArgs = Array.isArray(config.args) ? config.args : []
  const envOverrides = config.env || {}
  const startupTimeoutMs = Math.max(100, Number(config.startup_timeout_ms || 5000))
  const requestTimeoutMs = Math.max(100, Number(config.request_timeout_ms || config.timeout_ms || 30000))
  const healthCheckMethod = normalizeHealthMethod(config.health_check_method)
  const configuredFraming = normalizeFraming(config.framing)
  const isWindows = process.platform === "win32"
  const explicitShell = config.shell === true || (config.shell !== false && isWindows)

  let executable
  let spawnArgs
  if (Array.isArray(command)) {
    executable = command[0]
    spawnArgs = command.slice(1)
  } else {
    executable = command
    spawnArgs = cmdArgs
  }

  if (!executable) {
    throw new McpError(`mcp server "${serverName}" missing command`, {
      reason: "spawn_failed",
      server: serverName,
      phase: "startup"
    })
  }

  const maxReconnectAttempts = Number(config.max_reconnect_attempts ?? 5)
  const circuitResetMs = Number(config.circuit_reset_ms ?? 60000)

  let child = null
  let lifecycle = "closed"
  let nextId = 1
  let initialized = false
  let activeFraming = configuredFraming === "auto" ? "content-length" : configuredFraming
  let decoder = createStdioFramingDecoder({
    framing: configuredFraming === "auto" ? "auto" : activeFraming
  })
  let malformedSeen = false
  let malformedSnippet = ""
  let stderrLines = []
  let stderrTotalBytes = 0
  let ignoreClose = false
  let reconnectAttempts = 0
  let circuitState = "closed" // "closed" | "open" | "half_open"
  let circuitOpenedAt = 0
  let wasEverInitialized = false

  const pending = new Map()

  function resetRuntime() {
    decoder = createStdioFramingDecoder({
      framing: configuredFraming === "auto" ? "auto" : activeFraming
    })
    malformedSeen = false
    malformedSnippet = ""
    stderrLines = []
    stderrTotalBytes = 0
  }

  function appendStderr(chunk) {
    const text = String(chunk || "").trim()
    if (!text) return
    stderrTotalBytes += Buffer.byteLength(chunk)
    stderrLines.push(text)
    if (stderrLines.length > 32) stderrLines = stderrLines.slice(stderrLines.length - 32)
  }

  function rejectPending(reason, message, details = {}) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(
        new McpError(message, {
          reason,
          server: serverName,
          action: entry.method,
          phase: entry.phase || details.phase || "request",
          stderrSnippet: stderrLines.join(" | ") || undefined,
          ...details
        })
      )
    }
    pending.clear()
  }

  function cleanupChild() {
    child = null
    initialized = false
    lifecycle = "closed"
  }

  async function startProcess() {
    if (child && lifecycle !== "closed") return

    resetRuntime()
    lifecycle = "starting"
    ignoreClose = false

    await new Promise((resolve, reject) => {
      let settled = false
      const proc = spawn(executable, spawnArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...envOverrides },
        windowsHide: true,
        shell: explicitShell
      })
      child = proc

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { proc.kill() } catch {}
        reject(
          new McpError(`mcp server "${serverName}" startup timeout after ${startupTimeoutMs}ms`, {
            reason: "timeout",
            server: serverName,
            phase: "startup"
          })
        )
      }, startupTimeoutMs)

      proc.once("spawn", () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        lifecycle = "running"
        resolve()
      })

      proc.once("error", (err) => {
        const reason = classifySpawnError(err)
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(
            new McpError(`mcp server "${serverName}" process error: ${err.message}`, {
              reason,
              server: serverName,
              phase: "startup"
            })
          )
        } else {
          rejectPending(reason, `mcp server "${serverName}" process error: ${err.message}`, { phase: "request" })
        }
      })

      proc.stdout.on("data", (chunk) => {
        let payloads = []
        try {
          payloads = decoder.push(chunk)
        } catch (error) {
          malformedSeen = true
          malformedSnippet = String(error.message || "invalid framing").slice(0, 240)
          return
        }

        for (const payload of payloads) {
          let msg
          try {
            msg = JSON.parse(payload)
          } catch {
            malformedSeen = true
            malformedSnippet = String(payload || "").slice(0, 240)
            continue
          }

          if (msg?.id != null && pending.has(msg.id)) {
            const entry = pending.get(msg.id)
            pending.delete(msg.id)
            clearTimeout(entry.timer)
            if (msg.error) {
              entry.reject(
                new McpError(
                  `mcp server "${serverName}" error: ${msg.error.message || JSON.stringify(msg.error)}`,
                  {
                    reason: "bad_response",
                    server: serverName,
                    action: entry.method,
                    phase: entry.phase,
                    code: msg.error.code,
                    stderrSnippet: stderrLines.join(" | ") || undefined
                  }
                )
              )
            } else {
              const elapsed = Date.now() - entry.startedAt
              EventBus.emit({
                type: EVENT_TYPES.MCP_REQUEST,
                payload: { server: serverName, action: entry.method, elapsed, transport: "stdio" }
              }).catch(() => {})
              entry.resolve(msg.result ?? {})
            }
          }
        }
      })

      proc.stderr.on("data", (chunk) => appendStderr(chunk))

      proc.on("close", (code, signal) => {
        if (ignoreClose) {
          cleanupChild()
          return
        }
        const reason = malformedSeen ? "bad_response" : "server_crash"
        const extra = malformedSeen && malformedSnippet
          ? `; malformed stdout: ${malformedSnippet}`
          : ""
        rejectPending(
          reason,
          `mcp server "${serverName}" process exited unexpectedly (code=${code ?? "null"}, signal=${signal || "null"})${extra}`,
          { phase: lifecycle === "starting" ? "startup" : "request" }
        )
        cleanupChild()
      })
    })
  }

  const shutdownTimeoutMs = Number(config.shutdown_timeout_ms || 5000)

  async function shutdownProcess() {
    if (!child) return
    const proc = child
    lifecycle = "stopping"
    ignoreClose = true
    try { proc.kill() } catch {}
    rejectPending("unknown", `mcp server "${serverName}" shutdown`, { phase: "shutdown" })
    await new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        try { proc.kill("SIGKILL") } catch {}
        resolve()
      }, shutdownTimeoutMs)
      proc.once("close", () => {
        clearTimeout(killTimer)
        resolve()
      })
    })
    cleanupChild()
  }

  async function ensureAlive() {
    // Circuit breaker: open state rejects immediately
    if (circuitState === "open") {
      if (Date.now() - circuitOpenedAt >= circuitResetMs) {
        circuitState = "half_open"
      } else {
        throw new McpError(`mcp server "${serverName}" circuit breaker open`, {
          reason: "server_crash", server: serverName, phase: "request"
        })
      }
    }

    // Only attempt lazy reconnect if we were previously initialized
    if ((lifecycle === "closed" || lifecycle === "stopping") && wasEverInitialized) {
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
      if (reconnectAttempts > 0) {
        await new Promise((r) => setTimeout(r, delay))
      }
      try {
        initialized = false
        await startProcess()
        await initializeOnce()
        reconnectAttempts = 0
        if (circuitState === "half_open") {
          circuitState = "closed"
          EventBus.emit({ type: EVENT_TYPES.MCP_CIRCUIT_CLOSE, payload: { server: serverName } }).catch(() => {})
        }
        EventBus.emit({ type: EVENT_TYPES.MCP_RECONNECT, payload: { server: serverName, success: true } }).catch(() => {})
      } catch (error) {
        reconnectAttempts++
        if (circuitState === "half_open" || reconnectAttempts >= maxReconnectAttempts) {
          circuitState = "open"
          circuitOpenedAt = Date.now()
          EventBus.emit({ type: EVENT_TYPES.MCP_CIRCUIT_OPEN, payload: { server: serverName, attempts: reconnectAttempts } }).catch(() => {})
        }
        EventBus.emit({ type: EVENT_TYPES.MCP_RECONNECT, payload: { server: serverName, success: false, attempt: reconnectAttempts } }).catch(() => {})
        throw error
      }
      return
    }

    // Normal first-time startup
    await startProcess()
  }

  async function sendRequest(method, params = {}, { phase = "request", timeoutMs = requestTimeoutMs, signal = null } = {}) {
    if (signal?.aborted) {
      throw new McpError(`mcp server "${serverName}" request cancelled`, {
        reason: "timeout", server: serverName, action: method, phase
      })
    }
    await ensureAlive()
    if (nextId > Number.MAX_SAFE_INTEGER - 1) nextId = 1
    const id = nextId++
    const payload = { jsonrpc: "2.0", id, method, params }

    return new Promise((resolve, reject) => {
      const startedAt = Date.now()
      let settled = false

      function settle() {
        if (settled) return false
        settled = true
        if (signal) signal.removeEventListener("abort", onAbort)
        return true
      }

      function onAbort() {
        if (!settle()) return
        clearTimeout(timer)
        pending.delete(id)
        sendNotification("notifications/cancelled", { requestId: id, reason: "client_cancelled" })
        reject(new McpError(`mcp server "${serverName}" request cancelled`, {
          reason: "timeout", server: serverName, action: method, phase
        }))
      }

      const timer = setTimeout(() => {
        if (!settle()) return
        pending.delete(id)
        reject(
          new McpError(`mcp server "${serverName}" timed out after ${timeoutMs}ms on "${method}"`, {
            reason: "timeout",
            server: serverName,
            action: method,
            phase
          })
        )
      }, timeoutMs)

      if (signal) signal.addEventListener("abort", onAbort, { once: true })

      pending.set(id, {
        resolve: (v) => { if (settle()) { clearTimeout(timer); resolve(v) } },
        reject: (e) => { if (settle()) { clearTimeout(timer); reject(e) } },
        timer, method, phase, startedAt
      })
      try {
        const wireFraming = configuredFraming === "auto" ? activeFraming : configuredFraming
        child.stdin.write(encodeRpcMessage(payload, wireFraming))
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(
          new McpError(`mcp server "${serverName}" stdin write failed: ${error.message}`, {
            reason: "server_crash",
            server: serverName,
            action: method,
            phase
          })
        )
      }
    })
  }

  function sendNotification(method, params = {}) {
    if (!child || lifecycle === "closed") return
    const payload = { jsonrpc: "2.0", method, params }
    try {
      const wireFraming = configuredFraming === "auto" ? activeFraming : configuredFraming
      child.stdin.write(encodeRpcMessage(payload, wireFraming))
    } catch {
      // best effort
    }
  }

  async function initializeOnce() {
    if (initialized) return
    const initParams = {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: MCP_CLIENT_INFO
    }

    if (configuredFraming === "auto") {
      let lastError = null
      let needRestart = false
      for (const candidate of ["content-length", "newline"]) {
        activeFraming = candidate
        if (needRestart) {
          await shutdownProcess()
        }
        try {
          decoder.reset()
          await sendRequest("initialize", initParams, { phase: "initialize" })
          sendNotification("notifications/initialized")
          initialized = true
          wasEverInitialized = true
          return
        } catch (error) {
          lastError = error
          needRestart = true
        }
      }
      throw lastError || new McpError(`mcp server "${serverName}" failed to initialize`, {
        reason: "unknown",
        server: serverName,
        phase: "initialize"
      })
    }

    await sendRequest("initialize", initParams, { phase: "initialize" })
    sendNotification("notifications/initialized")
    initialized = true
    wasEverInitialized = true
  }

  async function healthPingOrTools() {
    if (healthCheckMethod === "ping") {
      await sendRequest("ping", {}, { phase: "request" })
      return
    }
    if (healthCheckMethod === "tools_list") {
      await sendRequest("tools/list", {}, { phase: "request" })
      return
    }

    try {
      await sendRequest("ping", {}, { phase: "request" })
    } catch (error) {
      if (!["bad_response", "protocol_error", "unknown"].includes(error.reason)) throw error
      await sendRequest("tools/list", {}, { phase: "request" })
    }
  }

  return {
    serverName,
    transport: "stdio",

    async health() {
      try {
        await initializeOnce()
        await healthPingOrTools()
        return {
          ok: true,
          reason: "ok",
          framing: configuredFraming === "auto" ? activeFraming : configuredFraming
        }
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          reason: error.reason || "unknown",
          phase: error.details?.phase || "unknown",
          framing: configuredFraming === "auto" ? activeFraming : configuredFraming
        }
      }
    },

    async listTools() {
      await initializeOnce()
      const out = await sendRequest("tools/list")
      return Array.isArray(out?.tools) ? out.tools : []
    },

    async listPrompts() {
      await initializeOnce()
      try {
        const out = await sendRequest("prompts/list")
        return Array.isArray(out?.prompts) ? out.prompts : []
      } catch {
        return []
      }
    },

    async getPrompt(name, args = {}) {
      await initializeOnce()
      return sendRequest("prompts/get", { name, arguments: args })
    },

    async listResources() {
      await initializeOnce()
      try {
        const out = await sendRequest("resources/list")
        return Array.isArray(out?.resources) ? out.resources : []
      } catch {
        return []
      }
    },

    async listTemplates() {
      await initializeOnce()
      try {
        const out = await sendRequest("resources/templates/list")
        return Array.isArray(out?.templates) ? out.templates : []
      } catch {
        return []
      }
    },

    async callTool(name, args = {}, signal = null) {
      await initializeOnce()
      const result = await sendRequest("tools/call", { name, arguments: args }, { signal })
      return normalizeToolResult(result, serverName, name)
    },

    shutdown() {
      sendNotification("notifications/cancelled", { reason: "shutdown" })
      rejectPending("shutdown", `mcp server "${serverName}" shutdown`, { phase: "shutdown" })
      shutdownProcess().catch(() => {})
    }
  }
}
