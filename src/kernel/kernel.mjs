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
 * ## 2b 过渡桥（2c/阶段 3 移除）
 *
 * 当前 executeTurn 的执行路径（session/engine → loop → executor）仍读进程级
 * 默认单例。为让 kernel 的配置对 executeTurn 真实生效，createKernel 会：
 *   1. 把 trustState 与 handlers.onPermissionPrompt/onQuestionPrompt 同步
 *      安装到进程级默认引擎/槽位（shutdown 时按位恢复）；
 *   2. 订阅进程级默认 EventBus，把事件流桥接进本实例的 events 总线
 *     （单向：默认 → 实例；实例内 emit 不回灌默认总线）。
 * 因此同一进程里多个 kernel 并发 executeTurn 时，默认路径上的信任态与提示
 * 槽位以**最后创建的 kernel** 为准 —— 这是 2b 的已知限制，2c 迁移执行路径
 * 后消失。实例字段（permissions/tools/…）本身始终互不影响。
 *
 * ## shutdown
 *
 * 收口：事件桥与宿主回调退订 → 默认槽位/信任态按位恢复 →
 * McpRegistry.shutdown()（进程级连接池）→ session flushNow()。
 * 多 kernel 共存时，任一 kernel 的 shutdown 会关闭共享 MCP 连接池
 * （进程级资源的代价，见上）。
 */
import { loadConfig } from "../config/load-config.mjs"
import { applyWorkspaceTrustPolicy, bootstrapKernelExtensions } from "../context.mjs"
import { createEventBus, defaultEventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { createPermissionEngine, PermissionEngine } from "../permission/engine.mjs"
import { createPermissionPromptChannel, defaultPermissionPromptChannel } from "../permission/prompt.mjs"
import { createQuestionPromptChannel, defaultQuestionPromptChannel } from "../tool/question-prompt.mjs"
import { createToolRegistry } from "../tool/registry.mjs"
import { McpRegistry } from "../mcp/registry.mjs"
import { createSkillRegistry } from "../skill/registry.mjs"
import { createHookBus } from "../plugin/hook-bus.mjs"
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
  flushNow
} from "../session/store.mjs"
import { compactSession } from "../session/compaction.mjs"
import { confirmRollback, executeRollback, handleRollbackIfNeeded } from "../session/rollback.mjs"
import { executeTool } from "../tool/executor.mjs"
import { BackgroundManager } from "../orchestration/background-manager.mjs"
import { createTaskDelegate } from "../orchestration/task-scheduler.mjs"

/**
 * @param {object} [options]
 * @param {string} [options.cwd] 工作目录（默认 process.cwd()）
 * @param {object} [options.config] 已加载的 configState（宿主覆盖项）；缺省时
 *   kernel 自己跑 loadConfig(cwd) —— loadConfig → extensionPolicy 链路的唯一
 *   归属（§7.4）。`configState` 是同义别名。
 * @param {object} [options.trustState] 工作区信任态（{ trusted }）；
 *   `options.trust === true` 是其简写。
 * @param {object} [options.handlers] 宿主回调注入：
 *   onPermissionPrompt / onQuestionPrompt（取代模块级 set*PromptHandler 槽位）、
 *   onOutput（executeTurn 的默认 output 通道）、onEvent（订阅 kernel 事件流）。
 * @returns {Promise<object>} kernel 句柄（§4.1 API 面）
 */
export async function createKernel(options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const handlers = options.handlers || {}
  const configState = options.config ?? options.configState ?? await loadConfig(cwd)
  const trustState = options.trustState ?? { trusted: options.trust === true }
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

  // --- 2b 过渡桥（详见文件头注释）---
  const bridgeUnsubscribe = defaultEventBus.subscribe(async (event) => {
    await events.emit(event)
  })
  const onEventUnsubscribe = typeof handlers.onEvent === "function"
    ? events.subscribe(handlers.onEvent)
    : null
  const previousDefaultTrust = PermissionEngine.isTrusted()
  PermissionEngine.setTrusted(trustState?.trusted === true)
  const previousPermissionHandler = defaultPermissionPromptChannel.getPermissionPromptHandler()
  if (typeof handlers.onPermissionPrompt === "function") {
    defaultPermissionPromptChannel.setPermissionPromptHandler(handlers.onPermissionPrompt)
  }
  const previousQuestionHandler = defaultQuestionPromptChannel.getQuestionPromptHandler()
  if (typeof handlers.onQuestionPrompt === "function") {
    defaultQuestionPromptChannel.setQuestionPromptHandler(handlers.onQuestionPrompt)
  }

  // --- boot 序列（唯一归属：bootstrapKernelExtensions）作用于本实例注册表 ---
  const extensionPolicy = await bootstrapKernelExtensions({
    cwd,
    configState,
    trustState,
    registries: { permissions, tools, skills, hooks }
  })

  async function executeTurn(turnOptions = {}) {
    return executeEngineTurn({
      ...turnOptions,
      configState: turnOptions.configState ?? configState,
      output: turnOptions.output ?? (typeof handlers.onOutput === "function" ? handlers.onOutput : null)
    })
  }

  let shutdownDone = false
  async function shutdown() {
    if (shutdownDone) return
    shutdownDone = true
    bridgeUnsubscribe()
    if (onEventUnsubscribe) onEventUnsubscribe()
    // 恢复 2b 过渡桥改动的进程级默认槽位 —— 仅当槽位里仍是我们装的 handler，
    // 避免踩掉 kernel 创建之后别的宿主注册的新 handler。
    if (typeof handlers.onPermissionPrompt === "function"
      && defaultPermissionPromptChannel.getPermissionPromptHandler() === handlers.onPermissionPrompt) {
      defaultPermissionPromptChannel.setPermissionPromptHandler(previousPermissionHandler)
    }
    if (typeof handlers.onQuestionPrompt === "function"
      && defaultQuestionPromptChannel.getQuestionPromptHandler() === handlers.onQuestionPrompt) {
      defaultQuestionPromptChannel.setQuestionPromptHandler(previousQuestionHandler)
    }
    PermissionEngine.setTrusted(previousDefaultTrust)
    await mcp.shutdown()
    await flushNow()
  }

  return {
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
    extensionPolicy,
    configState,
    cwd,
    shutdown
  }
}
