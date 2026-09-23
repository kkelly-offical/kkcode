/**
 * src/kernel/index.mjs —— 内核白名单 facade
 * （docs/architecture-kernel-sdk-1.0.0.md §4.2.1）。
 *
 * frontends（src/repl.mjs、src/repl/、src/ui/、src/commands/、src/cli/）只允许
 * import 本文件（与 src/sdk/），禁止 deep-import 内核内部文件 —— 由
 * scripts/check-boundaries.mjs 与 eslint no-restricted-imports 在 CI 强制
 * （§6 阶段 4 完成判据）。
 *
 * 白名单分三组（每组内按子域归拢，新增导出必须在这里登记理由）：
 *
 *   1. createKernel() —— 唯一组合根（§4），返回 §4.1 的句柄 API 面。有句柄
 *      在场的调用点（slash 命令的 ctx.kernel、入口刚创建的 kernel）优先用
 *      句柄方法，不要从 facade 拿同义函数。
 *   2. 无状态契约面：模式/事件常量与纯函数（modes、EVENT_TYPES、…）、provider
 *      目录与向导、权限规则纯函数等。它们不进 kernel 句柄（句柄是实例方法集），
 *      frontends 按需取。
 *   3. 进程级显式例外（§7.2/§7.3 契约）：会话存储读写、BackgroundManager /
 *      LongAgentManager、默认事件总线 / 默认权限引擎 / 默认 HookBus / 两个
 *      默认提示通道、agent 注册表（模块级单例 CustomAgentRegistry 与内建
 *      agent 目录 listAgents，以及配套 authoring 面 generateAgent /
 *      saveAgentGlobal）。2b 过渡期 executeTurn 路径仍读进程级默认值
 *      （kernel.mjs 头注），frontends 需要影响回合判定时必须拿这一组（例如
 *      REPL 的 setPersistGrantHandler）；deprecated 的 PermissionEngine/
 *      EventBus/HookBus 代理别名不经 facade 再导出。
 */

// ── 1. 组合根 ─────────────────────────────────────────────────────────
export { createKernel } from "./kernel.mjs"
export { runtimeCwd } from './core/runtime-context.mjs'
export { installPlugin, managePlugin } from './plugin/manager.mjs'

// ── 2a. core：模式契约与事件类型（纯常量 / 纯函数）─────────────────────
export {
  MODE_IDS,
  MODE_CYCLE,
  DEFAULT_MODE_ID,
  APPROVAL_LEVELS,
  DEFAULT_APPROVAL,
  getMode,
  laneOf,
  approvalOf,
  nextModeId,
  prevModeId,
  modeIdFromLegacy,
  modeIdFromLaneAndApproval,
  resolveSessionMode,
  approvalFromLegacy
} from "./core/modes.mjs"
export { EVENT_TYPES, QUESTION_SKIPPED } from "./core/constants.mjs"
export { mediaBlockError } from './core/media.mjs'
// Shared bounded decoder used by the device preview API and all model inputs.
export { normalizeImageBlock, prepareImageMessages, IMAGE_LIMITS } from './media/images.mjs'
export { noteDeprecation } from "./core/deprecations.mjs"

// ── 2b. permission 规则与信任存储（纯函数 / platform 落盘）─────────────
export { normalizePermissionLevel } from "./permission/rules.mjs"
export { checkWorkspaceTrust, persistTrust, revokeTrust } from "./permission/workspace-trust.mjs"
export {
  listLearnedRules,
  removeLearnedRules,
  isLearnedRule,
  describeRule,
  appendLearnedRule,
  buildLearnedRule
} from "./permission/learned-rules.mjs"

// ── 2c. provider 目录 / 向导 / 模型工具 ───────────────────────────────
export {
  discoverModelsForProvider,
  resolveProviderConnection,
  applyDiscoveredContextLimits,
  applyDiscoveredCapabilities,
  readCachedModelCatalog,
  resolveModelCapabilities
} from "./provider/model-catalog.mjs"
export {
  MODEL_CAPABILITY_KEYS,
  normalizeCapabilities,
  parseCatalogEntryCapabilities,
  parseCatalogEntryPricing,
  inferCapabilitiesFromName,
  enforceModelInputCapabilities
} from "./provider/model-capabilities.mjs"
export { escapeTerminalText, validateModelId } from "./provider/model-id.mjs"
export { assertMediaInput, mediaInputSupport } from './provider/media-input.mjs'
export { resolveRoleModel } from "./provider/model-roles.mjs"
export { requestFast, isFastModelConfigured, fastModelIssues } from "./provider/fast-model.mjs"
export { VENDOR_PRESETS, saveProviderConfig } from "./provider/wizard.mjs"
export { runProviderAddForm, runProviderEditForm, formatContext } from "./provider/wizard-form.mjs"
export { THINKING_TIERS, normalizeThinkingTier, supportsThinking } from "./provider/thinking-effort.mjs"

// ── 2d. tool / skill / plugin 的无状态工具面 ──────────────────────────
export {
  readClipboardImage,
  readClipboardText,
  sniffImageMediaType,
  isImagePath,
  normalizeDroppedPath,
  extractImageRefs,
  buildContentBlocks
} from "./tool/image-util.mjs"
export { inspectSandboxStatus, formatSandboxLine } from "./tool/sandbox.mjs"
export { readClipboardMedia, readMediaFileAsBlock } from './tool/media-util.mjs'
export { browserStatus } from './browser/controller.mjs'
export { ensureDefaultSkillPack } from "./skill/registry.mjs"
export { generateSkill, saveSkillGlobal } from "./skill/generator.mjs"
export { discoverLocalPluginManifests } from "./plugin/manifest-loader.mjs"

// ── 2e. session 的模式路由 / 观测 / 报告纯函数 ────────────────────────
export {
  ensureEventSinks,
  routeMode,
  resolvePromptMode,
  resolveMode,
  getPublicModeContract,
  formatPublicModeSummary,
  summarizeRouteDecision,
  newSessionId,
  executeTurn
} from "./session/engine.mjs"
export {
  emitRouteDecisionEvent,
  emitAgentContinuationInterrupted,
  emitAgentContinuationResumed
} from "./session/routing-observability.mjs"
export {
  listRecoverableSessions,
  getResumeContext,
  isRecoveryEnabled,
  summarizeResumeContext
} from "./session/recovery.mjs"
export { summarizeSessionRuntimeState } from "./session/runtime-state.mjs"
export { inspectPrompt } from './session/prompt-report.mjs'
export { listToolOperations, resolveToolOperation } from './tool/operation-journal.mjs'
export { buildAgentContinuationPrompt, summarizeAgentTransaction } from "./session/agent-transaction.mjs"
export { rewindLastTurn } from "./session/rewind.mjs"
export { normalizeTitle } from './session/session-title.mjs'
export { buildBlockedReport, renderBlockedReportText } from "./session/blocked-report.mjs"
export { loadLedger } from "./session/ultra-ledger.mjs"
export { runLongAgent } from "./session/longagent.mjs"
export { exitCodeForUltraStatus } from "./session/ultra-status.mjs"

// ── 3. 进程级显式例外（§7.2/§7.3 契约，见本文件头注第 3 组）────────────
export { defaultEventBus } from "./core/events.mjs"
export { defaultPermissionEngine } from "./permission/engine.mjs"
export { defaultPermissionPromptChannel } from "./permission/prompt.mjs"
export { defaultQuestionPromptChannel } from "./tool/question-prompt.mjs"
export { defaultHookBus } from "./plugin/hook-bus.mjs"
// provider 进程级默认注册表（9 组单例之一）：kernel 实例有自己的注册表
// （句柄 providers），这两个函数是 2b 过渡期 executeTurn 路径实际读的默认表。
export { listProviders, requestProvider } from "./provider/router.mjs"
export { BackgroundManager } from "./orchestration/background-manager.mjs"
export { LongAgentManager } from "./orchestration/longagent-manager.mjs"
export { applyWorktreeResult, discardWorktreeResult } from "./orchestration/worktree-handoff.mjs"
export {
  getSession,
  listSessions,
  exportSession,
  forkSession,
  fsckSessionStore,
  gcSessionStore,
  flushNow,
  getConversationHistory,
  appendMessage,
  applyReviewDecision
} from "./session/store.mjs"
export { compactSession } from "./session/compaction.mjs"
export { confirmRollback, executeRollback, handleRollbackIfNeeded } from "./session/rollback.mjs"
// agent 注册表单例（第十子域 src/kernel/agent/，M23 迁入）：内建 agent 目录
// 与自定义 agent 注册表是模块级全局一份，authoring 命令经 facade 消费。
export { listAgents } from "./agent/agent.mjs"
export { CustomAgentRegistry } from "./agent/custom-agent-loader.mjs"
export { generateAgent, saveAgentGlobal } from "./agent/generator.mjs"
