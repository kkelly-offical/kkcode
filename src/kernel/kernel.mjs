/** Instance-owned runtime. AsyncLocalStorage carries the explicit dependency
 * container through legacy internal call sites without swapping global state. */
import { runWithRuntime, currentRuntime } from './core/runtime-context.mjs'
import { createAgentMap } from './agent/agent.mjs'
import { loadConfig } from "../config/load-config.mjs"
import { applyWorkspaceTrustPolicy, bootstrapKernelExtensions, resolveExtensionPolicy } from "../context.mjs"
import { checkWorkspaceTrust } from "./permission/workspace-trust.mjs"
import { createEventBus } from "./core/events.mjs"
import { EVENT_TYPES } from "./core/constants.mjs"
import { createPermissionEngine } from "./permission/engine.mjs"
import { createPermissionPromptChannel } from "./permission/prompt.mjs"
import { createQuestionPromptChannel } from "./tool/question-prompt.mjs"
import { createToolRegistry } from "./tool/registry.mjs"
import { createMcpRegistry } from "./mcp/registry.mjs"
import { createSkillRegistry } from "./skill/registry.mjs"
import { createHookBus } from "./plugin/hook-bus.mjs"
import { CustomAgentRegistry } from "./agent/custom-agent-loader.mjs"
import { createProviderRegistry, listProviders, getProvider } from "./provider/router.mjs"
import {
  executeTurn as executeEngineTurn,
  routeMode,
  resolvePromptMode,
  resolveMode,
  getPublicModeContract,
  newSessionId
} from "./session/engine.mjs"
import {
  touchSession,
  updateSession,
  appendMessage,
  appendPart,
  replaceMessages,
  getSession,
  listSessions,
  getConversationHistory,
  forkSession,
  markSessionStatus,
  appendUserMessage,
  appendAssistantMessage,
  configureSessionStore,
  flushNow
} from "./session/store.mjs"
import { configureEventLog } from "../storage/event-log.mjs"
import { configureAuditStore } from "../storage/audit-store.mjs"
import { compactSession } from "./session/compaction.mjs"
import { confirmRollback, executeRollback, handleRollbackIfNeeded } from "./session/rollback.mjs"
import { executeTool } from "./tool/executor.mjs"
import { BackgroundManager } from "./orchestration/background-manager.mjs"
import { createTaskDelegate } from "./orchestration/task-scheduler.mjs"

/**
 * @param {object} [options]
 * @param {string} [options.cwd] 工作目录（默认 process.cwd()）
 * @param {object} [options.config] 已加载的 configState（宿主覆盖项）；缺省时
 *   kernel 自己跑 loadConfig(cwd) —— loadConfig → extensionPolicy 链路的唯一
 *   归属（§7.4）。`configState` 是同义别名。
 * @param {object} [options.configState] `config` 的同义别名。
 * @param {boolean} [options.trust] 命令行 --trust 简写：授信并持久化本工作区。
 * @param {{ trusted?: boolean }} [options.trustState] 工作区信任态；缺省时按
 *   buildContext 原语义探测（持久化信任存储 + TTY 交互提示）。
 * @param {boolean} [options.boot] 置 false 跳过扩展 boot 序列（只读巡检命令用：
 *   不 spawn MCP、不写技能种子包）；注册表仍可经句柄按需 initialize。
 * @param {object} [options.handlers] 宿主回调注入：
 *   onPermissionPrompt / onQuestionPrompt（取代模块级 set*PromptHandler 槽位）、
 *   onOutput（executeTurn 的默认 output 通道）、onEvent（订阅 kernel 事件流）。
 * @param {Function} [options.handlers.onPermissionPrompt]
 * @param {Function} [options.handlers.onQuestionPrompt]
 * @param {Function} [options.handlers.onOutput]
 * @param {Function} [options.handlers.onEvent]
 * @returns {Promise<object>} kernel 句柄（§4.1 API 面）
 */
export async function createKernel(options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const handlers = options.handlers || {}
  const configState = options.config ?? options.configState ?? await loadConfig(cwd)

  // storage 层配置注入（原 buildContext 平台侧，阶段 2c 收口进组合根）。
  // 只下发配置里显式出现的键：缺省键与平台模块默认值本就一致，跳过可避免
  // 覆盖宿主在 createKernel 之前对存储层的自行配置。
  const storageConfig = /** @type {any} */ (configState).config?.storage || {}
  const sessionStoreOptions = {}
  if (storageConfig.session_shard_enabled !== undefined) {
    sessionStoreOptions.sessionShardEnabled = Boolean(storageConfig.session_shard_enabled)
  }
  if (storageConfig.flush_interval_ms !== undefined) {
    sessionStoreOptions.flushIntervalMs = Number(storageConfig.flush_interval_ms)
  }
  configureSessionStore(sessionStoreOptions)
  const eventLogOptions = {}
  if (storageConfig.event_rotate_mb !== undefined) eventLogOptions.rotateMb = Number(storageConfig.event_rotate_mb)
  if (storageConfig.event_retain_days !== undefined) eventLogOptions.retainDays = Number(storageConfig.event_retain_days)
  configureEventLog(eventLogOptions)
  const auditStoreOptions = {}
  if (storageConfig.audit_max_entries !== undefined) auditStoreOptions.maxEntries = Number(storageConfig.audit_max_entries)
  configureAuditStore(auditStoreOptions)

  // 信任探测（原 buildContext 平台侧）：宿主没给 trustState 时读持久化信任
  // 存储；内核不碰 TTY（阶段 3b），交互式询问由宿主注入 —— REPL 在
  // createKernel 之前用前端 prompt 探测好再传 trustState；headless 宿主应
  // 显式传 trustState 或 trust，否则未持久化授信的工作区确定性 untrusted。
  let trustState = options.trustState ?? await checkWorkspaceTrust({
    cwd,
    cliTrust: Boolean(options.trust),
    isTTY: process.stdin.isTTY
  })
  applyWorkspaceTrustPolicy(configState, trustState, cwd)

  // --- 9 组单例 → 实例字段 ---
  const events = createEventBus()
  const permissionPrompt = createPermissionPromptChannel()
  const questionPrompt = createQuestionPromptChannel()
  const permissions = createPermissionEngine({ promptChannel: permissionPrompt, eventBus: events })
  const mcp = createMcpRegistry()
  const tools = createToolRegistry({ mcpRegistry: mcp })
  const skills = createSkillRegistry()
  const hooks = createHookBus()
  const providers = createProviderRegistry()
  // Snapshot explicitly registered legacy providers at creation; subsequent
  // registration changes remain isolated to their owning registry.
  for (const name of listProviders()) providers.registerProvider(name, getProvider(name))
  const hostController = new AbortController()
  const runtime = { cwd, events, permissions, tools, skills, hooks, providers, mcp, permissionPrompt, questionPrompt, hostSignal: hostController.signal, agents: createAgentMap(), customAgentState: { agents: new Map(), loaded: false, loadedAt: 0 } }
  const run = fn => runWithRuntime(runtime, fn)
  const activeTurns = new Set()
  permissions.setTrusted(trustState?.trusted === true)

  if (typeof handlers.onPermissionPrompt === "function") {
    permissionPrompt.setPermissionPromptHandler(handlers.onPermissionPrompt)
  }
  if (typeof handlers.onQuestionPrompt === "function") {
    questionPrompt.setQuestionPromptHandler(request => handlers.onQuestionPrompt({ ...request, sessionId: request.sessionId || currentRuntime()?.sessionId }))
  }

  const onEventUnsubscribe = typeof handlers.onEvent === 'function' ? events.subscribe(handlers.onEvent) : null
  function releaseProcessBridge() { hostController.abort(); onEventUnsubscribe?.() }

  // --- boot 序列（唯一归属：bootstrapKernelExtensions）作用于本实例注册表 ---
  // options.boot === false 时推迟（只读巡检命令：不 spawn MCP、不写技能种子包），
  // 句柄经 kernel.bootExtensions() 在确认要跑回合后再引导。
  let extensionPolicy = resolveExtensionPolicy(configState)
  let booted = false
  async function bootExtensions() {
    if (booted) return extensionPolicy
    extensionPolicy = await run(() => bootstrapKernelExtensions({
      cwd,
      configState,
      trustState,
      registries: { permissions, tools, skills, hooks }
    }))
    booted = true
    return extensionPolicy
  }
  if (options.boot !== false) {
    try {
      await bootExtensions()
    } catch (error) {
      // 失败对称回滚：createKernel reject 不得泄漏已安装的桥/槽位/信任态
      releaseProcessBridge()
      throw error
    }
  }

  /**
   * @param {object} [turnOptions] 与 session/engine.mjs executeTurn 同形
   *   （单对象 16 字段，§4.1）；configState/output 缺省时由句柄注入。
   * @param {object} [turnOptions.configState]
   * @param {string} [turnOptions.sessionId]
   * @param {object|null} [turnOptions.output]
   */
  async function executeTurn(turnOptions = {}) {
    if (activeTurns.has(turnOptions.sessionId)) throw new Error('A turn is already running in this session')
    activeTurns.add(turnOptions.sessionId)
    try { return await runWithRuntime({ ...runtime, sessionId: turnOptions.sessionId }, () => executeEngineTurn(/** @type {any} */ ({
      ...turnOptions,
      configState: turnOptions.configState ?? configState,
      output: turnOptions.output ?? (typeof handlers.onOutput === "function" ? handlers.onOutput : null)
    }))) } finally { activeTurns.delete(turnOptions.sessionId) }
  }

  /**
   * /trust /untrust 的句柄方法（1.0.0 阶段 2c，M3 耦合点 6 收尾）。
   *
   * 信任态翻转后五套注册表（工具/技能/子智能体/钩子/自定义命令）必须一起重建，
   * 漏一套就是「已 /trust 但项目工具仍被拦」。自定义命令是 REPL 前端状态，
   * 由调用方（repl/commands/permission.mjs） reload；其余四套连同
   * applyWorkspaceTrustPolicy 与信任标志一起收口在这里。
   *
   * 2b 过渡期 executeTurn 路径（engine→loop→executor）仍读进程级默认注册表，
   * 所以实例注册表与默认注册表两侧都重建；阶段 3 执行路径迁入实例后，
   * 默认侧随之消失。
   */
  async function applyTrustState(nextTrustState = {}) {
    trustState = { trusted: nextTrustState.trusted === true }
    applyWorkspaceTrustPolicy(configState, trustState, cwd)
    extensionPolicy = resolveExtensionPolicy(configState)
    permissions.setTrusted(trustState.trusted)
    // 2b 桥：默认引擎/默认注册表是 executeTurn 路径实际读的那份（见文件头）
    const { allowProjectSources } = extensionPolicy
    await tools.initialize({ config: extensionPolicy.config, cwd, force: true, allowProjectSources })
    await skills.initialize(extensionPolicy.config, cwd, { allowProjectSources })
    await hooks.initialize(cwd, extensionPolicy.config, { allowProjectSources, force: true })
    // CustomAgentRegistry 是 kernel/agent 的模块级单例（第十子域，M23 迁入），全局一份
    await CustomAgentRegistry.initialize(cwd, { allowProjectSources })
    return extensionPolicy
  }

  let shutdownDone = false
  async function shutdown() {
    if (shutdownDone) return
    releaseProcessBridge()
    try {
      await handle.extensions.mcp.shutdown()
    } finally {
      // flushNow 必达：mcp.shutdown 抛错也要把会话缓冲写盘收口；
      // shutdownDone 只在全链路成功后置位，失败允许宿主重试。
      await flushNow()
    }
    shutdownDone = true
  }

  const handle = {
    executeTurn,
    turns: {
      executeTurn,
      routeMode,
      resolvePromptMode,
      resolveMode,
      getPublicModeContract,
      newSessionId
    },
    sessions: {
      touchSession,
      updateSession,
      appendMessage,
      appendPart,
      replaceMessages,
      getSession,
      listSessions,
      getConversationHistory,
      forkSession,
      markSessionStatus,
      appendUserMessage,
      appendAssistantMessage,
      compactSession,
      confirmRollback,
      executeRollback,
      handleRollbackIfNeeded
    },
    permissions,
    tools: {
      initialize: (initOptions) => tools.initialize(initOptions),
      isReady: () => tools.isReady(),
      list: (listOptions) => tools.list(listOptions),
      get: (toolName) => tools.get(toolName),
      call: (toolName, args, ctx) => tools.call(toolName, args, ctx),
      refreshMcpTools: () => tools.refreshMcpTools(),
      executeTool: (execOptions) => executeTool(execOptions)
    },
    extensions: { skills, mcp, hooks },
    background: {
      launch: (args) => BackgroundManager.launch(args),
      launchDelegateTask: (args) => BackgroundManager.launchDelegateTask(args),
      get: (id) => BackgroundManager.get(id),
      list: () => BackgroundManager.list(),
      summary: () => BackgroundManager.summary(),
      createTaskDelegate
    },
    providers,
    events: {
      emit: (event) => events.emit(event),
      subscribe: (fn) => events.subscribe(fn),
      registerSink: (fn) => events.registerSink(fn),
      listenerCount: () => events.listenerCount(),
      EVENT_TYPES
    },
    prompts: { permission: permissionPrompt, question: questionPrompt },
    get extensionPolicy() { return extensionPolicy },
    configState,
    cwd,
    get trustState() { return trustState },
    applyTrustState,
    bootExtensions,
    shutdown
  }
  /** @template {object} T @param {T} object @returns {T} */
  const bind = object => /** @type {T} */ (Object.fromEntries(Object.entries(object).map(([key, value]) => [key, typeof value === 'function' ? (...args) => run(() => value.apply(object, args)) : value])))
  handle.sessions = bind(handle.sessions)
  handle.tools = bind(handle.tools)
  handle.background = bind(handle.background)
  handle.extensions = { skills: bind(skills), hooks: bind(hooks), mcp: bind(mcp) }
  handle.applyTrustState = (...args) => run(() => applyTrustState(...args))
  handle.run = run
  return handle
}
