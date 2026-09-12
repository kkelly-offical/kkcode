/**
 * createKernel() —— 1.0.0 进程内核的唯一组合根
 * （docs/architecture-kernel-sdk-1.0.0.md §4，阶段 2a/2b 落地）。
 *
 * ## 单例收编（M3 §四.2 的 9 组模块级单例 → 实例字段）
 *
 * 每个 kernel 实例持有自己的：
 *   - events          EventBus（listeners/sinks）
 *   - permissions     PermissionEngine（sessionAllow/workspaceTrusted/persistGrantHandler）
 *   - tools           ToolRegistry（工具集与签名缓存）
 *   - extensions.mcp  McpRegistry（见下「进程级例外」）
 *   - extensions.skills  SkillRegistry
 *   - extensions.hooks   HookBus
 *   - providers       Provider 注册表（预置内建 provider）
 *   - 审批/提问提示槽位（permission/question 的 customPromptHandler，
 *     经 options.handlers.onPermissionPrompt / onQuestionPrompt 注入）
 *
 * ## 进程级例外（§7.2/§7.3 显式契约）
 *
 * 以下状态刻意保持进程级，不按 kernel 实例化：
 *   - MCP 连接池（extensions.mcp 指向默认实例）：每 kernel 各开一池子进程
 *     连接代价不可接受；若未来改为实例池，属于显式契约变更。
 *   - 会话存储（session/store）与后台任务编排（BackgroundManager）：
 *     platform/持久化层，append 式落盘 + checkpoint 文件天然进程级。
 *
 * ## 上下文构建收口（阶段 2c）
 *
 * buildContext（src/context.mjs）的平台侧职责已收进 createKernel：storage 层
 * 配置注入（session store / event log / audit store 读 config.storage.*）与
 * 工作区信任探测（trustState 缺省时 checkWorkspaceTrust 读持久化存储；内核
 * 不碰 TTY —— 交互式信任询问由宿主在 createKernel 之前自行完成并传入
 * trustState，见 repl.mjs 的 prompt 注入）。theme/profile 属 frontends 层
 * （§2），留在宿主侧。
 * buildContext 仍按原样导出（兼容），但入口（repl.mjs、commands/*、
 * background-worker）一律经 createKernel 拿句柄，不再直接调它。
 *
 * ## background worker 独立进程模型（§7.3 显式契约）
 *
 * BackgroundManager 以 `spawn(process.execPath, [background-worker.mjs, ...])`
 * 起独立进程跑委派任务；worker 进程内 createKernel() 重启内核是自然形态。
 * 主进程与 worker 的注册表/信任态/事件总线天然两份，跨进程状态只靠
 * checkpoint JSON 与 payload 序列化传递；进程级例外（MCP 连接池、会话存储）
 * 也随之每个进程各一份。每个入口进程保持一个 kernel 实例：同进程多 kernel
 * 并发 executeTurn 时默认路径的信任态/提示槽位以后创建者为准（2b 已知限制）。
 *
 * ## 2b 过渡桥（2c/阶段 3 移除）
 *
 * 当前 executeTurn 的执行路径（session/engine → loop → executor）仍读进程级
 * 默认单例。为让 kernel 的配置对 executeTurn 真实生效，createKernel 会：
 *   1. 把 trustState 与 handlers.onPermissionPrompt/onQuestionPrompt 同步
 *      安装到进程级默认引擎/槽位（全部 kernel 关闭后一次性恢复为首个
 *      createKernel 之前捕获的原始值，与关闭顺序无关 —— 见
 *      processBridgeLedger；桥存活期间默认槽位归桥管）；
 *   2. 订阅进程级默认 EventBus，把事件流桥接进本实例的 events 总线
 *     （单向：默认 → 实例；实例内 emit 不回灌默认总线）。
 * 因此同一进程里多个 kernel 并发 executeTurn 时，默认路径上的信任态与提示
 * 槽位以**最后创建的 kernel** 为准 —— 这是 2b 的已知限制，2c 迁移执行路径
 * 后消失。实例字段（permissions/tools/…）本身始终互不影响。
 *
 * ## shutdown
 *
 * 收口：事件桥与宿主回调退订 → 引用计数递减（归零时恢复默认槽位/信任态为
 * 原始值）→ McpRegistry.shutdown()（进程级连接池）→ session flushNow()
 * （try/finally 保证必达）。任一环节抛错则 shutdown reject 且不置完成位，
 * 允许宿主重试。多 kernel 共存时，任一 kernel 的 shutdown 会关闭共享 MCP
 * 连接池（进程级资源的代价，见上）。
 */
import { loadConfig } from "../config/load-config.mjs"
import { applyWorkspaceTrustPolicy, bootstrapKernelExtensions, resolveExtensionPolicy } from "../context.mjs"
import { checkWorkspaceTrust } from "../permission/workspace-trust.mjs"
import { createEventBus, defaultEventBus } from "./core/events.mjs"
import { EVENT_TYPES } from "./core/constants.mjs"
import { createPermissionEngine, PermissionEngine } from "../permission/engine.mjs"
import { createPermissionPromptChannel, defaultPermissionPromptChannel } from "../permission/prompt.mjs"
import { createQuestionPromptChannel, defaultQuestionPromptChannel } from "../tool/question-prompt.mjs"
import { createToolRegistry, ToolRegistry } from "../tool/registry.mjs"
import { McpRegistry } from "../mcp/registry.mjs"
import { createSkillRegistry, SkillRegistry } from "../skill/registry.mjs"
import { createHookBus, initHookBus } from "../plugin/hook-bus.mjs"
import { CustomAgentRegistry } from "../agent/custom-agent-loader.mjs"
import { createProviderRegistry } from "../provider/router.mjs"
import {
  executeTurn as executeEngineTurn,
  routeMode,
  resolvePromptMode,
  resolveMode,
  getPublicModeContract,
  newSessionId
} from "../session/engine.mjs"
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
} from "../session/store.mjs"
import { configureEventLog } from "../storage/event-log.mjs"
import { configureAuditStore } from "../storage/audit-store.mjs"
import { compactSession } from "../session/compaction.mjs"
import { confirmRollback, executeRollback, handleRollbackIfNeeded } from "../session/rollback.mjs"
import { executeTool } from "../tool/executor.mjs"
import { BackgroundManager } from "../orchestration/background-manager.mjs"
import { createTaskDelegate } from "../orchestration/task-scheduler.mjs"

/**
 * 2b 过渡桥的进程级账本。
 *
 * 桥安装会改写进程级默认信任态/审批/提问槽位；恢复必须回到「首个 kernel
 * 创建之前」的原始值，而不是各 kernel 创建时保存的前值 —— 后者隐含 LIFO
 * 假设：非 LIFO 关闭顺序下会把默认信任态恢复成错误值（信任门静默打开）、
 * 让默认槽位指向已销毁 kernel 的死 handler（review round 1 P1 实跑复现）。
 * 因此：首个 createKernel 捕获原始默认值，引用计数归零（全部 kernel
 * shutdown 或 createKernel 失败回滚）时才一次性恢复。
 */
const processBridgeLedger = {
  activeKernels: 0,
  originalTrust: false,
  originalPermissionHandler: null,
  originalQuestionHandler: null
}

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
  const tools = createToolRegistry()
  const skills = createSkillRegistry()
  const hooks = createHookBus()
  const providers = createProviderRegistry()
  const mcp = McpRegistry // 进程级连接池（显式契约，见文件头注释）

  if (typeof handlers.onPermissionPrompt === "function") {
    permissionPrompt.setPermissionPromptHandler(handlers.onPermissionPrompt)
  }
  if (typeof handlers.onQuestionPrompt === "function") {
    questionPrompt.setQuestionPromptHandler(handlers.onQuestionPrompt)
  }

  // --- 2b 过渡桥（详见文件头注释；恢复语义见 processBridgeLedger）---
  const bridgeUnsubscribe = defaultEventBus.subscribe(async (event) => {
    await events.emit(event)
  })
  const onEventUnsubscribe = typeof handlers.onEvent === "function"
    ? events.subscribe(handlers.onEvent)
    : null
  if (processBridgeLedger.activeKernels === 0) {
    processBridgeLedger.originalTrust = PermissionEngine.isTrusted()
    processBridgeLedger.originalPermissionHandler = defaultPermissionPromptChannel.getPermissionPromptHandler()
    processBridgeLedger.originalQuestionHandler = defaultQuestionPromptChannel.getQuestionPromptHandler()
  }
  processBridgeLedger.activeKernels += 1
  PermissionEngine.setTrusted(trustState?.trusted === true)
  if (typeof handlers.onPermissionPrompt === "function") {
    defaultPermissionPromptChannel.setPermissionPromptHandler(handlers.onPermissionPrompt)
  }
  if (typeof handlers.onQuestionPrompt === "function") {
    defaultQuestionPromptChannel.setQuestionPromptHandler(handlers.onQuestionPrompt)
  }

  // 桥释放 = 退订 + 引用计数递减；归零时把默认信任态/槽位恢复为桥安装前
  // 捕获的原始值（与关闭顺序无关，消掉越权残留）。shutdown 与 createKernel
  // 失败回滚共用这一段对称逻辑。
  let bridgeReleased = false
  function releaseProcessBridge() {
    if (bridgeReleased) return
    bridgeReleased = true
    bridgeUnsubscribe()
    if (onEventUnsubscribe) onEventUnsubscribe()
    processBridgeLedger.activeKernels -= 1
    if (processBridgeLedger.activeKernels === 0) {
      PermissionEngine.setTrusted(processBridgeLedger.originalTrust)
      defaultPermissionPromptChannel.setPermissionPromptHandler(processBridgeLedger.originalPermissionHandler)
      defaultQuestionPromptChannel.setQuestionPromptHandler(processBridgeLedger.originalQuestionHandler)
    }
  }

  // --- boot 序列（唯一归属：bootstrapKernelExtensions）作用于本实例注册表 ---
  // options.boot === false 时推迟（只读巡检命令：不 spawn MCP、不写技能种子包），
  // 句柄经 kernel.bootExtensions() 在确认要跑回合后再引导。
  let extensionPolicy = resolveExtensionPolicy(configState)
  let booted = false
  async function bootExtensions() {
    if (booted) return extensionPolicy
    extensionPolicy = await bootstrapKernelExtensions({
      cwd,
      configState,
      trustState,
      registries: { permissions, tools, skills, hooks }
    })
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
   * @param {object|null} [turnOptions.output]
   */
  async function executeTurn(turnOptions = {}) {
    return executeEngineTurn(/** @type {any} */ ({
      ...turnOptions,
      configState: turnOptions.configState ?? configState,
      output: turnOptions.output ?? (typeof handlers.onOutput === "function" ? handlers.onOutput : null)
    }))
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
    PermissionEngine.setTrusted(trustState.trusted)
    const { allowProjectSources } = extensionPolicy
    await tools.initialize({ config: extensionPolicy.config, cwd, force: true, allowProjectSources })
    await skills.initialize(extensionPolicy.config, cwd, { allowProjectSources })
    await hooks.initialize(cwd, extensionPolicy.config, { allowProjectSources, force: true })
    // CustomAgentRegistry 尚未收编（不在 M3 §四.2 的 9 组里），模块级单例全局一份
    await CustomAgentRegistry.initialize(cwd, { allowProjectSources })
    await ToolRegistry.initialize({ config: extensionPolicy.config, cwd, force: true, allowProjectSources })
    await SkillRegistry.initialize(extensionPolicy.config, cwd, { allowProjectSources })
    await initHookBus(cwd, extensionPolicy.config, { allowProjectSources, force: true })
    return extensionPolicy
  }

  let shutdownDone = false
  async function shutdown() {
    if (shutdownDone) return
    releaseProcessBridge()
    try {
      await mcp.shutdown()
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
      subscribe: (fn) => events.subscribe(fn),
      registerSink: (fn) => events.registerSink(fn),
      listenerCount: () => events.listenerCount(),
      EVENT_TYPES
    },
    get extensionPolicy() { return extensionPolicy },
    configState,
    cwd,
    get trustState() { return trustState },
    applyTrustState,
    bootExtensions,
    shutdown
  }
  return handle
}
