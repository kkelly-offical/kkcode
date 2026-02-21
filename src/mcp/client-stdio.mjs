import { spawn } from "node:child_process"
import { McpError } from "../core/errors.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { createStdioFramingDecoder, encodeRpcMessage } from "./stdio-framing.mjs"

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

function normalizeToolResult(result, serverName, toolName) {
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

  return content
    ? { output, raw: result, content }
    : { output, raw: result }
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
  let ignoreClose = false

  const pending = new Map()

  function resetRuntime() {
    decoder = createStdioFramingDecoder({
      framing: configuredFraming === "auto" ? "auto" : activeFraming
    })
    malformedSeen = false
    malformedSnippet = ""
    stderrLines = []
  }

  function appendStderr(chunk) {
    const text = String(chunk || "").trim()
    if (!text) return
    stderrLines.push(text)
    if (stderrLines.length > 8) stderrLines = stderrLines.slice(stderrLines.length - 8)
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

  async function shutdownProcess() {
    if (!child) return
    ignoreClose = true
    try {
      child.kill()
    } catch {}
    rejectPending("unknown", `mcp server "${serverName}" shutdown`, { phase: "shutdown" })
    cleanupChild()
  }

  async function sendRequest(method, params = {}, { phase = "request", timeoutMs = requestTimeoutMs } = {}) {
    await startProcess()
    const id = nextId++
    const payload = { jsonrpc: "2.0", id, method, params }

    return new Promise((resolve, reject) => {
      const startedAt = Date.now()
      const timer = setTimeout(() => {
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

      pending.set(id, { resolve, reject, timer, method, phase, startedAt })
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
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "kkcode", version: "0.1.2" }
    }

    if (configuredFraming === "auto") {
      let lastError = null
      for (const candidate of ["content-length", "newline"]) {
        activeFraming = candidate
        await shutdownProcess()
        try {
          await sendRequest("initialize", initParams, { phase: "initialize" })
          sendNotification("notifications/initialized")
          initialized = true
          return
        } catch (error) {
          lastError = error
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
      const result = await sendRequest("tools/call", { name, arguments: args })
      return normalizeToolResult(result, serverName, name)
    },

    shutdown() {
      sendNotification("notifications/cancelled", { reason: "shutdown" })
      shutdownProcess().catch(() => {})
    }
  }
}
