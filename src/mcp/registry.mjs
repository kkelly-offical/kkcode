import { createHttpMcpClient } from "./client-http.mjs"
import { createStdioMcpClient } from "./client-stdio.mjs"
import { createSseMcpClient } from "./client-sse.mjs"
import { McpError } from "../core/errors.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { readFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { join } from "node:path"
import { homedir } from "node:os"

const state = {
  loaded: false,
  servers: new Map(),
  tools: new Map(),
  prompts: new Map(),
  health: new Map(),
  configured: new Map(),
  loadedAt: 0,
  lastSignature: "",
  initPromise: null,
  shuttingDown: false
}

function normalizeTool(serverName, tool) {
  const id = `mcp_${serverName}_${tool.name}`
  return {
    id,
    server: serverName,
    name: tool.name,
    description: tool.description || `${serverName}:${tool.name}`,
    inputSchema: tool.inputSchema || tool.input_schema || { type: "object", properties: {}, required: [] }
  }
}

function normalizePrompt(serverName, prompt) {
  const id = `mcp_${serverName}_${prompt.name}`
  return {
    id,
    server: serverName,
    name: prompt.name,
    description: prompt.description || `${serverName}:${prompt.name}`,
    arguments: prompt.arguments || []
  }
}

const execFileAsync = promisify(execFile)
let context7InstallLock = null
async function ensureGlobalPackage(pkg) {
  const name = pkg.replace(/@[^/]*$/, "")
  try {
    await execFileAsync("npm", ["list", "-g", name], { timeout: 10000 })
  } catch {
    await execFileAsync("npm", ["install", "-g", pkg], { timeout: 120000 })
  }
}

function resolveTransport(server = {}) {
  const transport = String(server.transport || server.type || "stdio").toLowerCase()
  if (transport === "http") return "http"
  if (transport === "sse" || transport === "streamable-http") return "sse"
  return "stdio"
}

function createClient(name, server) {
  const transport = resolveTransport(server)
  if (transport === "sse") return createSseMcpClient(name, server)
  if (transport === "http") return createHttpMcpClient(name, server)
  return createStdioMcpClient(name, server)
}

function setHealth(name, serverConfig = {}, patch = {}) {
  const prev = state.health.get(name) || {
    name,
    transport: resolveTransport(serverConfig),
    ok: false,
    reason: "not_checked",
    error: null,
    lastCheckedAt: 0
  }
  const next = {
    ...prev,
    ...patch,
    name,
    transport: patch.transport || prev.transport || resolveTransport(serverConfig),
    lastCheckedAt: Date.now()
  }
  state.health.set(name, next)
  return next
}

/**
 * Dynamic discovery: load MCP server configs from well-known project files.
 * Checks (in order, merged):
 *   .mcp.json                — Claude Code / VS Code convention
 *   .mcp/config.json         — directory-based convention
 *   .kkcode/mcp.json         — kkcode-specific
 *   ~/.kkcode/mcp.json       — global user-level
 */
async function discoverProjectServers(cwd) {
  const candidates = [
    join(cwd, ".mcp.json"),
    join(cwd, ".mcp", "config.json"),
    join(cwd, ".kkcode", "mcp.json"),
    join(homedir(), ".kkcode", "mcp.json")
  ]
  const merged = {}
  for (const filePath of candidates) {
    try {
      const raw = await readFile(filePath, "utf-8")
      const parsed = JSON.parse(raw)
      const servers = parsed?.servers || parsed?.mcpServers || {}
      for (const [name, cfg] of Object.entries(servers)) {
        if (!merged[name]) merged[name] = cfg
      }
    } catch {
      // ignore missing/invalid files
    }
  }
  return merged
}

async function connectServer(name, server) {
  // Lazy install for context7 built-in server
  if (name === "context7" && server?.command === "context7-mcp") {
    if (!context7InstallLock) {
      context7InstallLock = ensureGlobalPackage("@upstash/context7-mcp@latest").catch(() => {
        context7InstallLock = null  // Reset on failure to allow retry
      })
    }
    await context7InstallLock
  }

  const transport = resolveTransport(server)
  let client
  try {
    client = createClient(name, server)
  } catch (error) {
    const health = setHealth(name, server, {
      ok: false,
      reason: error.reason || "unknown",
      error: error.message,
      transport
    })
    await EventBus.emit({
      type: EVENT_TYPES.MCP_HEALTH,
      payload: { server: name, ...health }
    })
    return null
  }

  let health
  try {
    health = await client.health()
  } catch (error) {
    health = { ok: false, reason: error.reason || "unknown", error: error.message || String(error) }
  }

  const normalizedHealth = setHealth(name, server, {
    ok: Boolean(health?.ok),
    reason: health?.reason || (health?.ok ? "ok" : "unknown"),
    error: health?.error || null,
    phase: health?.phase || null,
    transport
  })

  await EventBus.emit({
    type: EVENT_TYPES.MCP_HEALTH,
    payload: { server: name, ...normalizedHealth }
  })

  if (!normalizedHealth.ok) return null

  state.servers.set(name, client)

  // Discover tools
  try {
    const tools = await client.listTools()
    for (const tool of tools) {
      const normalized = normalizeTool(name, tool)
      state.tools.set(normalized.id, normalized)
    }
  } catch (error) {
    setHealth(name, server, {
      ok: false,
      reason: error.reason || "unknown",
      error: `listTools failed: ${error.message}`
    })
    state.servers.delete(name)
    await EventBus.emit({
      type: EVENT_TYPES.MCP_HEALTH,
      payload: { server: name, ...state.health.get(name) }
    })
    return null
  }

  // Discover prompts (optional)
  if (typeof client.listPrompts === "function") {
    try {
      const prompts = await client.listPrompts()
      for (const prompt of prompts) {
        const normalized = normalizePrompt(name, prompt)
        state.prompts.set(normalized.id, normalized)
      }
    } catch {
      // optional capability
    }
  }

  return client
}

async function reinitialize(config, { force = false, cwd = null } = {}) {
  state.shuttingDown = false
  const ttlMs = Math.max(0, Number(config?.runtime?.mcp_refresh_ttl_ms || 60000))
  const effectiveCwd = cwd || process.cwd()
  const sig = JSON.stringify({
    mcp: config?.mcp || {},
    runtime: config?.runtime || {},
    cwd: effectiveCwd
  })

  const cacheValid = state.loaded && !force && state.lastSignature === sig && Date.now() - state.loadedAt <= ttlMs
  if (cacheValid) return

  for (const [, client] of state.servers) {
    if (typeof client.shutdown === "function") {
      try { await Promise.resolve(client.shutdown()) } catch { /* best-effort */ }
    }
  }
  state.loaded = false
  state.servers.clear()
  state.tools.clear()
  state.prompts.clear()
  state.health.clear()
  state.configured.clear()

  // Built-in MCP servers (user config can override or disable with enabled: false)
  const builtinServers = {
    context7: {
      command: "context7-mcp",
      args: [],
      timeout_ms: 30000,
      framing: "newline"
    }
  }
  const configServers = config?.mcp?.servers || {}
  const discoveredServers = config?.mcp?.auto_discover !== false
    ? await discoverProjectServers(effectiveCwd)
    : {}
  const allServers = { ...builtinServers, ...discoveredServers, ...configServers }

  // Merge global mcp.* defaults into each server config (server-level overrides global)
  const mcpGlobalDefaults = {}
  for (const gk of ["timeout_ms", "shutdown_timeout_ms", "max_sse_buffer_bytes", "max_reconnect_attempts", "circuit_reset_ms", "max_buffer_bytes"]) {
    if (config?.mcp?.[gk] !== undefined) mcpGlobalDefaults[gk] = config.mcp[gk]
  }

  for (const [name, serverConfig] of Object.entries(allServers)) {
    const effective = { ...mcpGlobalDefaults, ...serverConfig }
    allServers[name] = effective
    state.configured.set(name, effective)
    if (serverConfig?.enabled === false) {
      setHealth(name, serverConfig, {
        ok: false,
        reason: "disabled",
        error: null
      })
    } else {
      setHealth(name, serverConfig, {
        ok: false,
        reason: "not_checked",
        error: null
      })
    }
  }

  const entries = Object.entries(allServers).filter(([, serverConfig]) => serverConfig?.enabled !== false)
  await Promise.allSettled(entries.map(([name, serverConfig]) => connectServer(name, serverConfig)))

  state.loaded = true
  state.loadedAt = Date.now()
  state.lastSignature = sig
}

export const McpRegistry = {
  async initialize(config, { force = false, cwd = null } = {}) {
    if (state.initPromise) {
      await state.initPromise
      if (!force) return
    }
    state.initPromise = reinitialize(config, { force, cwd })
    try {
      await state.initPromise
    } finally {
      state.initPromise = null
    }
  },

  isReady() {
    return state.loaded
  },

  listServers() {
    return [...state.servers.keys()]
  },

  serverInfo(name) {
    const health = state.health.get(name)
    if (!health) return null
    return {
      name,
      transport: health.transport,
      lastHealth: health.ok ? "ok" : "fail",
      reason: health.reason || "unknown",
      lastError: health.error || null
    }
  },

  healthSnapshot() {
    return [...state.health.entries()]
      .map(([name, health]) => ({
        name,
        transport: health.transport || "stdio",
        ok: Boolean(health.ok),
        reason: health.reason || "unknown",
        error: health.error || null,
        phase: health.phase || null,
        configured: state.configured.has(name),
        enabled: state.configured.get(name)?.enabled !== false,
        lastCheckedAt: health.lastCheckedAt || 0
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  },

  listTools() {
    return [...state.tools.values()]
  },

  listPrompts() {
    return [...state.prompts.values()]
  },

  async getPrompt(promptId, args = {}) {
    const prompt = state.prompts.get(promptId)
    if (!prompt) throw new McpError(`mcp prompt not found: ${promptId}`, { reason: "not_found", prompt: promptId })
    const client = state.servers.get(prompt.server)
    if (!client || typeof client.getPrompt !== "function") {
      throw new McpError(`mcp server "${prompt.server}" does not support prompts/get`, { reason: "not_supported", server: prompt.server })
    }
    try {
      return await client.getPrompt(prompt.name, args)
    } catch (error) {
      if (error instanceof McpError) throw error
      throw new McpError(`mcp prompt "${promptId}" failed: ${error?.message || error}`, {
        reason: "bad_response", server: prompt.server, prompt: promptId
      })
    }
  },

  async listResources(serverName) {
    const client = state.servers.get(serverName)
    if (!client) return []
    return client.listResources()
  },

  async listTemplates(serverName) {
    const client = state.servers.get(serverName)
    if (!client) return []
    return client.listTemplates()
  },

  async callTool(toolId, args = {}, signal = null) {
    if (state.shuttingDown) {
      throw new McpError("MCP registry is shutting down", { reason: "shutting_down" })
    }
    const tool = state.tools.get(toolId)
    if (!tool) throw new McpError(`mcp tool not found: ${toolId}`, { reason: "not_found", tool: toolId })
    let client = state.servers.get(tool.server)
    if (!client) throw new McpError(`mcp server not found: ${tool.server}`, { reason: "not_found", server: tool.server })
    const serverConfig = state.configured.get(tool.server)
    const serverTimeout = serverConfig?.timeout_ms
    let effectiveSignal = signal
    if (serverTimeout && !signal) {
      effectiveSignal = AbortSignal.timeout(serverTimeout)
    }
    try {
      return await client.callTool(tool.name, args, effectiveSignal)
    } catch (error) {
      if (error?.reason === "spawn_failed" || error?.reason === "server_crash") {
        setHealth(tool.server, serverConfig, {
          ok: false, reason: error.reason, error: error.message
        })
        try {
          await this.refreshServer(tool.server)
          client = state.servers.get(tool.server)
          if (client) return client.callTool(tool.name, args, effectiveSignal)
        } catch {}
      }
      throw error
    }
  },

  async refreshServer(name) {
    const serverConfig = state.configured.get(name)
    if (!serverConfig) throw new Error(`mcp server not configured: ${name}`)
    const existing = state.servers.get(name)
    if (existing && typeof existing.shutdown === "function") existing.shutdown()
    state.servers.delete(name)
    for (const [id, t] of state.tools) {
      if (t.server === name) state.tools.delete(id)
    }
    for (const [id, p] of state.prompts) {
      if (p.server === name) state.prompts.delete(id)
    }
    return connectServer(name, serverConfig)
  },

  async addServer(name, serverConfig) {
    if (state.servers.has(name)) {
      const existing = state.servers.get(name)
      if (typeof existing.shutdown === "function") existing.shutdown()
      state.servers.delete(name)
      for (const [id, t] of state.tools) {
        if (t.server === name) state.tools.delete(id)
      }
      for (const [id, p] of state.prompts) {
        if (p.server === name) state.prompts.delete(id)
      }
    }
    state.configured.set(name, serverConfig)
    return connectServer(name, serverConfig)
  },

  async healthCheck(serverName) {
    const client = state.servers.get(serverName)
    const serverConfig = state.configured.get(serverName)
    if (!client || !serverConfig) return { ok: false, reason: "not_found" }
    try {
      const result = await client.health()
      const patch = {
        ok: Boolean(result?.ok),
        reason: result?.reason || (result?.ok ? "ok" : "unknown"),
        error: result?.error || null
      }
      setHealth(serverName, serverConfig, patch)
      await EventBus.emit({ type: EVENT_TYPES.MCP_HEALTH, payload: { server: serverName, ...patch } })
      if (!result?.ok) {
        try { await this.refreshServer(serverName) } catch {}
      }
      return patch
    } catch (error) {
      const patch = { ok: false, reason: error.reason || "unknown", error: error.message }
      setHealth(serverName, serverConfig, patch)
      return patch
    }
  },

  async healthCheckAll() {
    const results = {}
    for (const name of state.configured.keys()) {
      if (state.configured.get(name)?.enabled === false) continue
      results[name] = await this.healthCheck(name)
    }
    return results
  },

  removeServer(name) {
    const client = state.servers.get(name)
    if (client && typeof client.shutdown === "function") client.shutdown()
    state.servers.delete(name)
    state.configured.delete(name)
    state.health.delete(name)
    for (const [id, t] of state.tools) {
      if (t.server === name) state.tools.delete(id)
    }
    for (const [id, p] of state.prompts) {
      if (p.server === name) state.prompts.delete(id)
    }
  },

  shutdown() {
    state.shuttingDown = true
    for (const [, client] of state.servers) {
      if (typeof client.shutdown === "function") client.shutdown()
    }
    state.servers.clear()
    state.tools.clear()
    state.prompts.clear()
    state.health.clear()
    state.configured.clear()
    state.loaded = false
    state.lastSignature = ""
  }
}
