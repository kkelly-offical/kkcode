import { runtimeCwd, currentRuntime } from "../core/runtime-context.mjs"
import { createHttpMcpClient } from "./client-http.mjs"
import { createStdioMcpClient } from "./client-stdio.mjs"
import { createSseMcpClient } from "./client-sse.mjs"
import { createSdkMcpClient } from './client-sdk.mjs'
import { McpError } from "../core/errors.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { userRootDir } from "../../storage/paths.mjs"
import { discoverLocalPluginManifests, pluginMcpServers } from "../plugin/manifest-loader.mjs"
import { deprecatedSingletonAlias } from "../core/deprecations.mjs"
import { validateMcpInput, validateMcpOutput } from './schema-validation.mjs'
import { snapshotToolArguments } from '../tool/schema-validation.mjs'

/**
 * McpRegistry 工厂（1.0.0 阶段 2a）：servers/tools/prompts/health/configured
 * 与 initPromise 单飞锁收编为实例字段（M3 §四.2）。
 *
 * 注意（§7.2 显式契约）：MCP 连接池是进程级资源 —— createKernel 目前让
 * `extensions.mcp` 指向进程级默认实例，而不是每个 kernel 各开一池连接；
 * 本工厂为多实例隔离（测试）与未来契约变更预留能力。
 */
export function createMcpRegistry() {
  function requestOptions(server, action, options = {}) {
    const runtime = currentRuntime()
    return { ...options, signal: options.signal || runtime?.signal, onprogress: progress => {
      try { options.onprogress?.(progress) } catch { /* host observer */ }
      // Only counters, never arbitrary server text/credentials, enter telemetry.
      if (!Number.isFinite(progress?.progress)) return
      runtime?.events?.emit({ type: 'mcp.progress', sessionId: runtime.sessionId, payload: { server, action, progress: progress.progress, ...(Number.isFinite(progress.total) ? { total: progress.total } : {}) } }).catch(() => {})
    } }
  }
  const state = {
    loaded: false,
    // 一次加载（前台或后台）正在进行中。与 loaded 正交：loaded 回答「上次
    // 加载完成了吗」，loading 回答「现在有没有在跑」—— 后台加载期间两者
    // 可以同时为 false/true，UI 的状态查询面据此区分「加载中」与「没配 MCP」。
    loading: false,
    servers: new Map(),
    tools: new Map(),
    prompts: new Map(),
    health: new Map(),
    configured: new Map(),
    diagnostics: [],
    loadedAt: 0,
    lastSignature: "",
    initPromise: null,
    shuttingDown: false,
    // 加载收口监听器（工具注册表用来原子换入新工具面）。与事件总线分开：
    // 监听器是内核内部的同步回调面，mcp.loaded 事件是给 UI 的广播面。
    loadListeners: new Set()
  }

  // Provider tool-name contract: OpenAI and Anthropic both require
  // ^[a-zA-Z0-9_-]{1,64}$. Raw server/tool names (dots, spaces, CJK, plugin
  // `server/name` slashes) used to flow straight into `mcp_<server>_<tool>`
  // ids and get rejected by the provider API; two distinct pairs could also
  // sanitize to the same id and silently overwrite each other.
  const TOOL_ID_MAX = 64

  function sanitizeIdPart(value) {
    const cleaned = String(value ?? "").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "")
    return cleaned || "x"
  }

  function boundToolId(baseId, salt) {
    if (baseId.length <= TOOL_ID_MAX) return baseId
    const hash = createHash("sha1").update(String(salt)).digest("hex").slice(0, 8)
    const head = baseId.slice(0, TOOL_ID_MAX - hash.length - 2).replace(/[_-]+$/g, "")
    return `${head}_${hash}`
  }

  function normalizeTool(serverName, tool) {
    const rawId = `mcp_${serverName}_${tool.name}`
    const baseId = boundToolId(`mcp_${sanitizeIdPart(serverName)}_${sanitizeIdPart(tool.name)}`, rawId)
    let id = baseId
    for (let n = 2; state.tools.has(id) && (state.tools.get(id).server !== serverName || state.tools.get(id).name !== tool.name); n += 1) {
      id = boundToolId(`${baseId}_${n}`, `${rawId}#${n}`)
    }
    if (baseId !== rawId) {
      state.diagnostics.push({ kind: "tool_id_sanitized", server: serverName, tool: tool.name, requestedId: rawId, id })
    }
    if (id !== baseId) {
      state.diagnostics.push({ kind: "tool_id_collision", server: serverName, tool: tool.name, requestedId: rawId, id })
    }
    return {
      id,
      server: serverName,
      name: tool.name,
      description: tool.description || `${serverName}:${tool.name}`,
      inputSchema: tool.inputSchema !== undefined ? tool.inputSchema : tool.input_schema !== undefined ? tool.input_schema : { type: "object", properties: {}, required: [] },
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {})
    }
  }

  function normalizePrompt(serverName, prompt) {
    const rawId = `mcp_${serverName}_${prompt.name}`
    const baseId = boundToolId(`mcp_${sanitizeIdPart(serverName)}_${sanitizeIdPart(prompt.name)}`, rawId)
    let id = baseId
    for (let n = 2; state.prompts.has(id) && (state.prompts.get(id).server !== serverName || state.prompts.get(id).name !== prompt.name); n += 1) {
      id = boundToolId(`${baseId}_${n}`, `${rawId}#${n}`)
    }
    if (id !== rawId) {
      state.diagnostics.push({ kind: "prompt_id_sanitized", server: serverName, prompt: prompt.name, requestedId: rawId, id })
    }
    return {
      id,
      server: serverName,
      name: prompt.name,
      description: prompt.description || `${serverName}:${prompt.name}`,
      arguments: prompt.arguments || []
    }
  }

  function resolveTransport(server = {}) {
    const transport = String(server.transport || server.type || "stdio").toLowerCase()
    if (transport === "http") return "http"
    if (transport === "streamable-http" || transport === 'legacy-sse') return transport
    if (transport === "sse") return "sse"
    return "stdio"
  }

  function createClient(name, server) {
    const transport = resolveTransport(server)
    if (transport === 'streamable-http' || transport === 'legacy-sse') return createSdkMcpClient(name, server)
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
   *   <KKCODE_HOME>/mcp.json    — global user-level
   */
  async function discoverProjectServers(cwd, allowProjectSources = true) {
    const candidates = [
      ...(allowProjectSources ? [
        join(cwd, ".mcp.json"),
        join(cwd, ".mcp", "config.json"),
        join(cwd, ".kkcode", "mcp.json")
      ] : []),
      join(userRootDir(), "mcp.json")
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

    if (!normalizedHealth.ok) {
      await client.shutdown?.().catch(() => {})
      return null
    }

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
      await client.shutdown?.().catch(() => {})
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

  async function shutdownClients(clients) {
    for (const client of clients) {
      if (typeof client.shutdown === "function") {
        try { await Promise.resolve(client.shutdown()) } catch { /* best-effort */ }
      }
    }
  }

  /**
   * 一轮加载的汇总：mcp.loaded 事件的 payload，也是 onLoad 监听器的入参。
   * 逐台 server 的失败已经各发过 MCP_HEALTH 并写进 health map，这里只汇总
   * 计数与失败清单 —— UI 一条瞬时通知需要的就是这些。
   */
  function buildLoadSummary({ background, startedAt, error = null }) {
    const failed = []
    let connected = 0
    let enabledCount = 0
    for (const [name, serverConfig] of state.configured) {
      if (serverConfig?.enabled === false) continue
      enabledCount += 1
      const health = state.health.get(name)
      if (health?.ok) connected += 1
      else failed.push({ name, reason: health?.reason || "unknown", error: health?.error || null })
    }
    return {
      background,
      ok: !error,
      error: error ? (error?.message || String(error)) : null,
      configured: enabledCount,
      connected,
      failed,
      toolCount: state.tools.size,
      promptCount: state.prompts.size,
      durationMs: Date.now() - startedAt
    }
  }

  async function announceLoad(summary) {
    for (const listener of state.loadListeners) {
      try { listener(summary) } catch { /* 监听器错误不能反过来影响加载 */ }
    }
    await EventBus.emit({ type: EVENT_TYPES.MCP_LOADED, payload: summary })
  }

  async function reinitialize(config, {
    force = false,
    cwd = null,
    allowProjectSources = true,
    background = false
  } = {}) {
    state.shuttingDown = false
    const ttlMs = Math.max(0, Number(config?.runtime?.mcp_refresh_ttl_ms || 60000))
    const effectiveCwd = cwd || runtimeCwd()
    const sig = JSON.stringify({
      mcp: config?.mcp || {},
      runtime: config?.runtime || {},
      cwd: effectiveCwd,
      allowProjectSources
    })

    const cacheValid = state.loaded && !force && state.lastSignature === sig && Date.now() - state.loadedAt <= ttlMs
    if (cacheValid) return null

    state.loading = true
    const startedAt = Date.now()
    try {
      await shutdownClients([...state.servers.values()])
      state.loaded = false
      state.servers.clear()
      state.tools.clear()
      state.prompts.clear()
      state.health.clear()
      state.configured.clear()
      state.diagnostics = []

      const configServers = config?.mcp?.servers || {}
      const discoveredServers = config?.mcp?.auto_discover !== false
        ? await discoverProjectServers(effectiveCwd, allowProjectSources)
        : {}
      const pluginState = await discoverLocalPluginManifests(effectiveCwd, config, {
        allowProjectSources
      })
      const rawPluginServers = pluginMcpServers(pluginState.plugins)
      const pluginServers = {}
      for (const [name, server] of Object.entries(rawPluginServers)) {
        const key = String(name).startsWith("plugin/") ? name : `plugin/${name}`
        pluginServers[key] = server
      }
      const allServers = { ...discoveredServers, ...pluginServers, ...configServers }

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

      // shutdown 抢在加载完成前发生：刚建出来的连接必须当场关掉，不置 loaded、
      // 不发事件 —— 否则进程退出后还留着一池活连接和一条迟到的「加载完成」。
      if (state.shuttingDown) {
        await shutdownClients([...state.servers.values()])
        state.servers.clear()
        state.tools.clear()
        state.prompts.clear()
        return null
      }

      state.loaded = true
      state.loadedAt = Date.now()
      state.lastSignature = sig
      const summary = buildLoadSummary({ background, startedAt })
      await announceLoad(summary)
      return summary
    } catch (error) {
      // 发现阶段的灾难性失败（配置解析、插件清单）与单 server 失败同级处理：
      // 降级成一条 ok:false 的汇总事件，绝不让 boot/回合被 MCP 拖进异常路径。
      if (state.shuttingDown) return null
      const summary = buildLoadSummary({ background, startedAt, error })
      await announceLoad(summary)
      return summary
    } finally {
      state.loading = false
    }
  }

  const McpRegistry = {
    /**
     * @param {object} [config] 配置（含 mcp.servers / runtime 段）
     * @param {object} [options]
     * @param {boolean} [options.force] 忽略缓存强制重载
     * @param {string} [options.cwd] 项目目录（驱动 .mcp.json 等发现）
     * @param {boolean} [options.allowProjectSources] 是否允许项目级来源
     * @param {boolean} [options.defer] 后台加载：把连接/工具发现挂到后台单飞
     *   promise 后立即返回，收口时发 mcp.loaded 汇总事件并回调 onLoad 监听
     *   器。就绪前该 server 的工具不在广告面上（registry.listTools 不含它）——
     *   这是刻意选定的语义（另一种是「首个用到的 turn 短等待带超时」）：
     *   广告面只陈述现在确定可用的东西，不把加载延迟藏进某一轮对话里。
     */
    async initialize(config, {
      force = false,
      cwd = null,
      allowProjectSources = true,
      defer = false
    } = {}) {
      if (state.initPromise) {
        // 后台加载已在进行中时，defer 调用方直接返回 —— 挂上去等就等于把
        // 后台加载又变回了阻塞点（回合里的 tools.list 会被拖住）。
        if (defer && !force) return
        await state.initPromise
        if (!force) return
      }
      const run = reinitialize(config, { force, cwd, allowProjectSources, background: defer })
      state.initPromise = run
      const cleanup = () => { if (state.initPromise === run) state.initPromise = null }
      if (defer) {
        // 不 await：reinitialize 自身不抛（灾难性失败也折成 ok:false 汇总），
        // then/cleanup 只负责释放单飞锁。
        run.then(cleanup, cleanup)
        return
      }
      try {
        await run
      } finally {
        cleanup()
      }
    },

    isReady() {
      return state.loaded
    },

    isLoading() {
      return state.loading
    },

    /** UI 的状态查询面：「加载中 / 就绪 / 失败降级」三态与各计数。 */
    loadState() {
      let connected = 0
      let enabledCount = 0
      for (const [name, serverConfig] of state.configured) {
        if (serverConfig?.enabled === false) continue
        enabledCount += 1
        if (state.health.get(name)?.ok) connected += 1
      }
      return {
        loaded: state.loaded,
        loading: state.loading,
        loadedAt: state.loadedAt || 0,
        configured: enabledCount,
        connected,
        toolCount: state.tools.size
      }
    },

    /**
     * 注册加载收口监听器（每轮加载完成/降级都会回调一次，含前台加载）。
     * 返回退订函数。内核内部消费面（工具注册表换广告面）；UI 请订阅
     * mcp.loaded 事件而不是这里。
     */
    onLoad(listener) {
      if (typeof listener !== "function") return () => {}
      state.loadListeners.add(listener)
      return () => state.loadListeners.delete(listener)
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

    diagnostics() {
      return [...state.diagnostics]
    },

    listPrompts() {
      return [...state.prompts.values()]
    },

    async getPrompt(promptId, args = {}, options = {}) {
      const prompt = state.prompts.get(promptId)
      if (!prompt) throw new McpError(`mcp prompt not found: ${promptId}`, { reason: "not_found", prompt: promptId })
      const client = state.servers.get(prompt.server)
      if (!client || typeof client.getPrompt !== "function") {
        throw new McpError(`mcp server "${prompt.server}" does not support prompts/get`, { reason: "not_supported", server: prompt.server })
      }
      try {
        return await client.getPrompt(prompt.name, args, requestOptions(prompt.server, 'prompts/get', options))
      } catch (error) {
        if (error instanceof McpError) throw error
        throw new McpError(`mcp prompt "${promptId}" failed: ${error?.message || error}`, {
          reason: "bad_response", server: prompt.server, prompt: promptId
        })
      }
    },

    async listResources(serverName, options = {}) {
      const client = state.servers.get(serverName)
      if (!client) return []
      if (!client.listResources) throw new McpError('此旧版 MCP 连接不支持资源列表', { reason: 'not_supported', server: serverName })
      return client.listResources(requestOptions(serverName, 'resources/list', options))
    },

    async readResource(serverName, uri, options = {}) {
      const client = state.servers.get(serverName)
      if (!client?.readResource) throw new McpError(`mcp resource reader unavailable: ${serverName}`, { reason: 'not_found', server: serverName })
      return client.readResource(uri, requestOptions(serverName, 'resources/read', options))
    },

    async listTemplates(serverName, options = {}) {
      const client = state.servers.get(serverName)
      if (!client) return []
      if (!client.listTemplates) throw new McpError('此旧版 MCP 连接不支持资源模板', { reason: 'not_supported', server: serverName })
      return client.listTemplates(requestOptions(serverName, 'resources/templates/list', options))
    },

    async callTool(toolId, args = {}, signal = null, options = {}) {
      try { args = snapshotToolArguments(args) } catch (error) { throw Object.assign(error, { operationNotStarted: true }) }
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
      await validateMcpInput(tool, args, effectiveSignal)
      const perform = async activeClient => {
        const result = await activeClient.callTool(tool.name, args, effectiveSignal, requestOptions(tool.server, 'tools/call', options))
        await validateMcpOutput(tool, result, effectiveSignal)
        return result
      }
      try {
        return await perform(client)
      } catch (error) {
        if (error?.operationNotStarted === true && (error?.reason === "spawn_failed" || error?.reason === "server_crash")) {
          setHealth(tool.server, serverConfig, {
            ok: false, reason: error.reason, error: error.message
          })
          try {
            await this.refreshServer(tool.server)
            client = state.servers.get(tool.server)
            if (client) {
              signal?.throwIfAborted()
              return perform(client)
            }
          } catch {}
        }
        throw error
      }
    },

    async authorize(name, options = {}) {
      const config = state.configured.get(name)
      if (!config || !['streamable-http', 'legacy-sse'].includes(String(config.transport || config.type))) throw new Error('OAuth requires a configured, trusted Streamable HTTP or SSE MCP server')
      const { loginMcpOAuth } = await import('./oauth.mjs')
      const result = await loginMcpOAuth(name, config, options)
      await this.refreshServer(name)
      return result
    },
    async clearAuthorization(name) {
      const config = state.configured.get(name)
      if (!config) throw new Error('MCP server is not configured in this trusted scope')
      const { createMcpOAuthProvider } = await import('./oauth.mjs')
      await createMcpOAuthProvider(name, config).store.clear()
      await state.servers.get(name)?.shutdown?.()
      state.servers.delete(name)
      for (const [id, tool] of state.tools) if (tool.server === name) state.tools.delete(id)
      return { signedOut: true, remoteRevoked: false }
    },
    async refreshServer(name) {
      const serverConfig = state.configured.get(name)
      if (!serverConfig) throw new Error(`mcp server not configured: ${name}`)
      const existing = state.servers.get(name)
      if (existing && typeof existing.shutdown === "function") {
        await Promise.resolve(existing.shutdown())
      }
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
        if (typeof existing.shutdown === "function") {
          await Promise.resolve(existing.shutdown())
        }
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
      const shutdown = client && typeof client.shutdown === "function"
        ? Promise.resolve(client.shutdown())
        : Promise.resolve()
      state.servers.delete(name)
      state.configured.delete(name)
      state.health.delete(name)
      for (const [id, t] of state.tools) {
        if (t.server === name) state.tools.delete(id)
      }
      for (const [id, p] of state.prompts) {
        if (p.server === name) state.prompts.delete(id)
      }
      return shutdown
    },

    async shutdown() {
      state.shuttingDown = true
      // 后台加载可能正在进行：先等它收口（它在收尾处看到 shuttingDown 会自己
      // 关掉刚建的连接），再清场 —— 不然加载完成时会把一池连接留给出局的进程。
      if (state.initPromise) {
        try { await state.initPromise } catch { /* 加载失败已被汇总事件覆盖 */ }
      }
      const clients = [...state.servers.values()]
      state.servers.clear()
      state.tools.clear()
      state.prompts.clear()
      state.health.clear()
      state.configured.clear()
      state.loaded = false
      state.lastSignature = ""
      await Promise.allSettled(clients.map((client) =>
        typeof client.shutdown === "function"
          ? Promise.resolve(client.shutdown())
          : Promise.resolve()
      ))
    }
  }
  return McpRegistry
}

const defaultMcpRegistry = createMcpRegistry()

/**
 * 兼容别名（deprecated）：进程级默认 McpRegistry 实例（连接池）。旧 import
 * 路径继续工作，每次方法调用经 deprecations.mjs 记录；新代码用
 * createKernel() 句柄的 `extensions.mcp`。
 */
export const McpRegistry = deprecatedSingletonAlias(
  "kernel.singleton.mcp-registry",
  "模块级单例 `McpRegistry` 已收编为 kernel 实例字段：新代码改用 createKernel() 句柄的 `extensions.mcp`",
  defaultMcpRegistry
)
