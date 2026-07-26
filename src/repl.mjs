import { PACKAGE_VERSION } from "./version.mjs"
import { maybeNotifyUpdateOnStartup } from "./update/checker.mjs"
import { buildPreflightReport } from "./cli/preflight.mjs"
import { stdin as input, stdout as output } from "node:process"
import { createInterface } from "node:readline/promises"
import { emitKeypressEvents } from "node:readline"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { basename, dirname, join, resolve as resolvePath } from "node:path"
import YAML from "yaml"
import {
  applyWorkspaceTrustPolicy,
  buildContext,
  printContextWarnings,
  resolveExtensionPolicy
} from "./context.mjs"
import { ensureEventSinks, newSessionId, resolveMode, routeMode } from "./session/engine.mjs"
import { summarizeRouteDecision } from "./session/engine.mjs"
import { buildAgentContinuationPrompt, summarizeAgentTransaction } from "./session/agent-transaction.mjs"
import {
  emitAgentContinuationInterrupted,
  emitAgentContinuationResumed,
  emitRouteDecisionEvent
} from "./session/routing-observability.mjs"
import { listProviders } from "./provider/router.mjs"
import { createWizardState, startWizard, startEditWizard, handleWizardInput } from "./provider/wizard.mjs"
import { discoverModelsForProvider, applyDiscoveredContextLimits, applyDiscoveredCapabilities } from "./provider/model-catalog.mjs"
import { escapeTerminalText, validateModelId } from "./provider/model-id.mjs"
import { loadCustomCommands, applyCommandTemplate } from "./command/custom-commands.mjs"
import { SkillRegistry } from "./skill/registry.mjs"
import { renderMarkdown } from "./theme/markdown.mjs"
import { listSessions, getConversationHistory } from "./session/store.mjs"
import { compactSession } from "./session/compaction.mjs"
import { ToolRegistry } from "./tool/registry.mjs"
import { McpRegistry } from "./mcp/registry.mjs"
import { initHookBus } from "./plugin/hook-bus.mjs"
import { renderReplDashboard, renderReplLogo, renderStartupHint } from "./ui/repl-dashboard.mjs"
import { renderCapabilityPanel } from "./ui/repl-capability-panel.mjs"
import { buildHelpText, buildShortcutLegend } from "./ui/repl-help.mjs"
import { buildRouteFeedback } from "./ui/repl-route-feedback.mjs"
import { formatRuntimeStateText, normalizeDiagnostics, normalizeFileChanges, renderDiagnosticsLines, renderFileChangeLines } from "./ui/repl-turn-summary.mjs"
import { renderFrameDashboardHeader, renderReplStatusLine, renderRuntimeDashboardView, renderStartupScreen } from "./ui/repl-status-view.mjs"
import { paint } from "./theme/color.mjs"
import { PermissionEngine } from "./permission/engine.mjs"
import { setPermissionPromptHandler } from "./permission/prompt.mjs"
import { setQuestionPromptHandler } from "./tool/question-prompt.mjs"
import { createActivityRenderer, formatPlanProgress, formatRecoverySuggestions } from "./ui/activity-renderer.mjs"
import { renderBlockedReportText } from "./session/blocked-report.mjs"
import { buildBoardModel, renderUltraBoard } from "./ui/ultra-board.mjs"
import { buildTranscriptViewport } from "./ui/repl-transcript-panel.mjs"
import { createAppState, reduceAppState } from "./ui/app-state.mjs"
import { renderTaskProgressPanel } from "./ui/repl-task-panel.mjs"
import { EventBus } from "./core/events.mjs"
import { EVENT_TYPES } from "./core/constants.mjs"
import { readClipboardImage, readClipboardText } from "./tool/image-util.mjs"
import { generateSkill, saveSkillGlobal } from "./skill/generator.mjs"
import { userRootDir, userConfigCandidates, projectConfigCandidates, memoryFilePath } from "./storage/paths.mjs"
import { persistTrust, revokeTrust } from "./permission/workspace-trust.mjs"
import { confirmRollback, executeRollback } from "./session/rollback.mjs"
import { loadProfile, runOnboarding } from "./onboarding.mjs"
import { MODE_CYCLE_ORDER, nextMode } from "./repl/keymap.mjs"
import {
  configuredProviders,
  loadHistoryLines,
  saveHistoryLines,
  clearScreen,
  resolveProviderDefaultModel,
  createInitialReplState,
  collectMcpStatusLines,
  startSplash
} from "./repl/core-shell.mjs"
import { runReplController } from "./repl/controller-entry.mjs"
import {
  collectInput,
  resolveHistoryNavigation,
  shouldApplySuggestionOnEnter as shouldApplySlashSuggestionOnEnter
} from "./repl/input-engine.mjs"
export { collectInput } from "./repl/input-engine.mjs"
// 帧度量与拼装原语。此前 repl.mjs 自带一份，与 repl-dashboard / activity-renderer /
// repl-help / text-layout 各自的副本互不一致 —— 见 frame-primitives.mjs 的说明。
import {
  stripAnsi, displayWidth, clipPlainByWidth, padRight, clipAnsiLine,
  wrapPlainLine, wrapLogLines, frameTop, frameBottom, frameDivider, frameRow,
  pageSize, ageLabel
} from "./repl/frame-primitives.mjs"
import {
  buildFrame as buildFrameLines,
  formatBusyToolDetail,
  renderSuggestions
} from "./repl/frame-builder.mjs"
import {
  slashSuggestions,
  applySuggestionToInput,
  normalizeSlashAlias
} from "./repl/slash-router.mjs"
import { renderInstalledCommandSurface, describeReloadSummary } from "./repl/command-surface.mjs"
import { executePromptTurn } from "./repl/turn-controller.mjs"
import { createGhostPredictor } from "./repl/ghost-predictor.mjs"
import { buildCapabilitySnapshot } from "./repl/capability-facade.mjs"
import { buildReplRuntimeSnapshot } from "./repl/runtime-facade.mjs"
import { buildOperatorSnapshot } from "./repl/operator-surface.mjs"
import {
  activateNextQuestionState,
  commitQuestionAnswer,
  advanceQuestionState,
  finalizeQuestionAnswers
} from "./repl/dialog-router.mjs"
import {
  POLICY_CHOICES,
  createPolicyPickerState,
  applyPolicyChoice,
  applyPermissionLevel,
  nextPermissionLevel,
  PERMISSION_PROMPT_CHOICES,
  PERMISSION_PROMPT_VALUES,
  defaultPermissionChoiceIndex
} from "./repl/permission-flow.mjs"
import { approvalFromLegacy, modeIdFromLegacy, nextModeId, MODE_IDS } from "./core/modes.mjs"
import { noteDeprecation } from "./core/deprecations.mjs"
import {
  applyModeSelection,
  resolveModeId,
  createModePickerState,
  formatModeBadge,
  MODE_PICKER_CHOICES
} from "./repl/mode-flow.mjs"
import { normalizePermissionLevel } from "./permission/rules.mjs"
import {
  buildLearnedRule,
  appendLearnedRule,
  listLearnedRules,
  removeLearnedRules,
  isLearnedRule,
  describeRule
} from "./permission/learned-rules.mjs"
import {
  classifySgrMouseEvent,
  createBracketedPasteDecoder,
  createSgrMouseDecoder,
  createUtf8TextDecoder,
  enterTerminalSequence,
  exitTerminalSequence,
  isScreenRowWithin,
  normalizeMouseSelection,
  renderTerminalFrame,
  resolveTerminalFeatures
} from "./repl/terminal-protocol.mjs"
import {
  inputIndexAtPosition,
  layoutInputText,
  moveGraphemeCursor,
  splitTextByCellRange
} from "./repl/text-layout.mjs"
import { copyTerminalText } from "./repl/clipboard.mjs"
import { createTranscriptModel } from "./ui/transcript-model.mjs"
import { createToastStore } from "./ui/toast-store.mjs"
import { shouldApplyActiveTurnEvent } from "./ui/event-scope.mjs"
import { createFrameBatcher } from "./ui/frame-batcher.mjs"
import {
  appendThinkingDelta,
  buildThinkingTranscriptItem,
  createThinkingState,
  finishThinking as finishThinkingState,
  formatThinkingDuration,
  startThinkingStream,
  startThinkingWait
} from "./ui/thinking-state.mjs"
import { mergeConfigObject } from "./config/merge.mjs"
import { renderSelectOverlay } from "./ui/overlay-select.mjs"
import { thinkingPreviewLines } from "./ui/thinking-preview.mjs"
import { rewindLastTurn } from "./session/rewind.mjs"
import { setMarkdownColors } from "./theme/markdown.mjs"
import { formatTokenCount } from "./theme/status-bar.mjs"
import {
  sanitizeTerminalStyledText,
  sanitizeTerminalText,
  sanitizeTerminalValue
} from "./theme/terminal-sanitize.mjs"

const HIST_DIR = userRootDir()
const HIST_FILE = join(HIST_DIR, "repl_history")
const HIST_SIZE = 500
const MAX_TUI_LOG_LINES = 1200
/** 连按两下 Esc 判定为回溯的时间窗 */
const DOUBLE_ESCAPE_MS = 1200
const MAX_TUI_SUGGESTIONS = 5
const MAX_MODEL_PICKER_VISIBLE = 8
const TUI_FRAME_MS = 16
const BUSY_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const ESCAPE_SEQUENCE_TIMEOUT_MS = 35
const KEYPRESS_ESCAPE_TIMEOUT_MS = 10



const BUILTIN_SLASH = [
  { name: "help", desc: "show help" },
  { name: "agents", desc: "list subagents with their permission tier" },
  { name: "tasks", desc: "list background tasks (add stop <id> / retry <id>)" },
  { name: "dash", desc: "redraw dashboard" },
  { name: "clear", desc: "clear terminal" },
  { name: "new", desc: "new session" },
  { name: "resume", desc: "resume session" },
  { name: "history", desc: "list sessions" },
  { name: "compact", desc: "summarize conversation to free context" },
  { name: "undo", desc: "undo last code changes" },
  { name: "mode", desc: "switch explicit mode" },
  { name: "plan", desc: "read-only development plan" },
  { name: "agent", desc: "assistant compatibility alias" },
  { name: "ultra", desc: "persistent staged development" },
  { name: "longagent", desc: "deprecated alias for /ultra" },
  { name: "provider", desc: "switch provider" },
  { name: "model", desc: "open model picker" },
  { name: "profile", desc: "view or edit your user profile" },
  { name: "like", desc: "show welcome screen / re-run onboarding" },
  { name: "trust", desc: "trust this workspace" },
  { name: "untrust", desc: "revoke workspace trust" },
  { name: "permission", desc: "permission policy / cache" },
  { name: "paste", desc: "paste image from clipboard" },
  { name: "status", desc: "runtime state" },
  { name: "keys", desc: "show key map" },
  { name: "session", desc: "show session id" },
  { name: "commands", desc: "list custom slash commands" },
  { name: "create-skill", desc: "generate a new skill via AI" },
  { name: "create-agent", desc: "generate a new sub-agent via AI" },
  { name: "reload", desc: "reload custom commands" },
  // 以下几条一直可以执行，却从未出现在补全菜单里 —— 目录与分发是两份
  // 各写各的清单，加命令时只改分发是最自然的疏忽。test/repl-slash-catalog
  // 现在会比对两者，漏一个就红。
  { name: "board", desc: "ultra goal board" },
  { name: "cls", desc: "clear terminal (alias of /clear)" },
  { name: "home", desc: "back to the dashboard view" },
  { name: "dashboard", desc: "redraw dashboard (alias of /dash)" },
  { name: "assistant", desc: "conversational mode" },
  { name: "code", desc: "coding mode" },
  { name: "coding", desc: "coding mode (alias of /code)" },
  { name: "yolo", desc: "unattended mode — approvals off" },
  { name: "exit", desc: "quit" }
]

function displayUserRootPath() {
  const userRoot = userRootDir()
  const home = process.env.HOME || process.env.USERPROFILE
  if (!home) return userRoot
  const homeNorm = resolvePath(home).replace(/\\/g, "/")
  const rootNorm = resolvePath(userRoot).replace(/\\/g, "/")
  if (rootNorm === homeNorm) return "~"
  if (rootNorm.startsWith(`${homeNorm}/`)) return `~${rootNorm.slice(homeNorm.length)}`
  return userRoot
}

export async function loadProviderModelItems(configState, providerName, {
  refresh = false,
  discover = discoverModelsForProvider
} = {}) {
  try {
    const catalog = await discover(configState, { providerName, refresh })
    // 目录里带上下文长度的模型，顺手合并进内存里的 model_context ——
    // 上限与状态栏百分比从此不用人肉填（用户显式写过的键不覆盖）。
    applyDiscoveredContextLimits(configState, catalog.models || [])
    applyDiscoveredCapabilities(configState, providerName, catalog.models || [])
    const seen = new Set()
    const items = []
    for (const entry of catalog.models || []) {
      const model = String(entry?.id || "").trim()
      if (!model || seen.has(model)) continue
      seen.add(model)
      items.push({
        provider: providerName,
        model,
        label: `${escapeTerminalText(providerName)} / ${escapeTerminalText(model)}`
      })
    }
    return {
      items,
      source: catalog.source,
      stale: Boolean(catalog.stale),
      warning: catalog.warning || null,
      error: null
    }
  } catch (error) {
    return {
      items: [],
      source: null,
      stale: false,
      warning: null,
      error: error?.message || "model discovery failed"
    }
  }
}

function parseConfigByPath(filePath, raw) {
  if (filePath.endsWith(".json")) return JSON.parse(raw)
  return YAML.parse(raw)
}

function stringifyConfigByPath(filePath, data) {
  if (filePath.endsWith(".json")) return JSON.stringify(data, null, 2) + "\n"
  return YAML.stringify(data)
}

const mergeObject = mergeConfigObject

function pickConfigPathForScope(scope, source, cwd = process.cwd()) {
  if (scope === "user") return source?.userPath || userConfigCandidates()[0]
  if (scope === "project") return source?.projectPath || projectConfigCandidates(cwd)[0]
  return null
}

/**
 * 就地切换模式：同时写 state.modeId、state.mode（航道）与
 * permission.level（审批档）。TUI 与行模式共用。
 */
function switchModeInPlace(state, ctx, modeId) {
  const permission = ctx.configState.config.permission || (ctx.configState.config.permission = {})
  const next = applyModeSelection(modeId, { permissionConfig: permission })
  state.modeId = next.modeId
  state.mode = next.mode
  ctx.configState.config.permission = next.permissionConfig
  return next
}

async function readConfigFile(target) {
  try {
    const raw = await readFile(target, "utf8")
    return parseConfigByPath(target, raw) || {}
  } catch {
    return {}
  }
}

async function writeConfigFile(target, data) {
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, stringifyConfigByPath(target, data), "utf8")
}

/**
 * 把一次「Always Allow」写入用户级配置。
 *
 * 刻意选用户级而非项目级：用户仓库的 .gitignore 未必忽略 .kkcode/，
 * 项目级会把授权记录提交出去。规则带 workspace 限定生效范围。
 */
async function persistLearnedGrant({ ctx, tool, pattern, command, workspace }) {
  const rule = buildLearnedRule({ tool, pattern, command, workspace: workspace || process.cwd() })
  if (!rule) return { added: false, reason: "invalid", rule: null }

  const target = pickConfigPathForScope("user", ctx.configState?.source, process.cwd())
  if (!target) return { added: false, reason: "no_target", rule }

  const existing = await readConfigFile(target)
  const currentRules = existing?.permission?.rules
  const outcome = appendLearnedRule(currentRules, rule)
  if (!outcome.added) return { added: false, reason: outcome.reason, rule }

  await writeConfigFile(target, {
    ...existing,
    permission: { ...(existing.permission || {}), rules: outcome.rules }
  })

  // 让本次会话立即生效，无需重启
  const live = ctx.configState.config.permission || (ctx.configState.config.permission = {})
  live.rules = appendLearnedRule(live.rules, rule).rules
  ctx.configState.source.userPath = target
  return { added: true, reason: "added", rule }
}

async function persistPermissionConfig({ scope, ctx, values }) {
  const source = ctx.configState?.source || {}
  const target = pickConfigPathForScope(scope, source, process.cwd())
  if (!target) throw new Error(`unable to resolve ${scope} config path`)

  const existing = await readConfigFile(target)
  const merged = mergeObject(existing, { permission: { ...values } })
  await writeConfigFile(target, merged)

  if (scope === "user") {
    ctx.configState.source.userPath = target
    ctx.configState.source.userDir = dirname(target)
    ctx.configState.source.userRaw = merged
  } else if (scope === "project") {
    ctx.configState.source.projectPath = target
    ctx.configState.source.projectDir = dirname(target)
    ctx.configState.source.projectRaw = merged
  }

  return target
}

function help(providers = []) {
  return buildHelpText({ providers, userRootPath: displayUserRootPath() })
}

function shortcutLegend() {
  return buildShortcutLegend()
}

function slashRouterOptions(customCommands = []) {
  return {
    builtinSlash: BUILTIN_SLASH,
    customCommands,
    skills: SkillRegistry.isReady() ? SkillRegistry.list() : []
  }
}

async function processInputLine({
  line,
  state,
  ctx,
  providersConfigured,
  customCommands,
  setCustomCommands,
  wizard,
  setWizard,
  providerPicker,
  setProviderPicker,
  print,
  streamSink = null,
  showTurnStatus = true,
  pendingImages = [],
  clearPendingImages = null,
  signal = null,
  suspendTui = null,
  // 只读信息浮层。TUI 会话里由 startTuiRepl 注入；行模式（无 TTY）下缺省为
  // null，此时回落到 print —— 那里没有帧可以浮，浮层无从存在。
  openPanel = null
}) {
  let normalized = normalizeSlashAlias(String(line || "").trim())

  /**
   * 只读信息的统一出口。
   *
   * 这类输出（`/status`、`/permission`、`/keys`…）是**查询当前状态**，给人看的：
   * 它不该进对话记录，否则会随会话发给模型、被 /clear 连带清掉，而且看完关不掉。
   * TUI 会话里走浮层；行模式（无 TTY，没有帧可浮）回落到折叠面板。
   */
  function showInfo(title, text, options = {}) {
    if (openPanel) {
      openPanel(title, text, options)
      return
    }
    print(typeof text === "function" ? text(Math.max(60, (process.stdout.columns || 120) - 4)) : text,
      { channel: "panel", title })
  }

  async function switchActiveProvider(name) {
    state.providerType = name
    state.model = resolveProviderDefaultModel(ctx.configState.config, name, state.model)
    print(`provider switched: ${name} (model: ${state.model})`, { channel: "notice", topic: "switch" })
    const catalog = await loadProviderModelItems(ctx.configState, name)
    if (catalog.items.length > 1) {
      print(`  可用模型 (${catalog.source}${catalog.stale ? ", stale" : ""}): ` + catalog.items.map(m => m.model).join(", "))
    }
    if (catalog.warning) print(`  模型目录提示: ${catalog.warning}`)
    if (catalog.error) print(`  模型目录不可用: ${catalog.error}；仍可使用 /model <model-id> 手动设置`)
  }

  // --- Provider 选择模式：拦截输入 ---
  if (providerPicker) {
    const list = providerPicker
    const input = normalized
    // 用户改主意敲了别的命令 —— 取消选择模式，让命令正常执行，
    // 而不是把 "/help" 当 provider 名去匹配然后报「找不到」
    if (input.startsWith("/")) {
      if (setProviderPicker) setProviderPicker(null)
      print("  已退出 provider 选择。")
    } else {
      if (setProviderPicker) setProviderPicker(null)
      if (!input) { print("  已取消。"); return { exit: false } }
      let target = null
      const num = Number(input)
      if (!isNaN(num) && num >= 1 && num <= list.length) {
        target = list[num - 1]
      } else {
        target = list.find((p) => p === input)
      }
      if (!target) { print(`  找不到 provider: "${input}"（可用: ${list.join(", ")}）`); return { exit: false } }
      if (target === state.providerType) { print(`  "${target}" 已经是当前 provider。`); return { exit: false } }
      await switchActiveProvider(target)
      return { exit: false }
    }
  }

  // --- 向导模式：拦截所有输入 ---
  if (wizard?.active) {
    const result = await handleWizardInput(wizard, line, print, {
      // Issue #3：向导需要看到现有配置才能识别内联 api_key
      existingProviders: ctx.configState.config.provider || {}
    })
    if (result.done && setWizard) setWizard({ ...wizard })
    // 热更新内存中的 config
    if (result.configPatch?.provider) {
      if (!ctx.configState.config.provider) ctx.configState.config.provider = {}
      Object.assign(ctx.configState.config.provider, result.configPatch.provider)
      if (result.configPatch.provider.default) {
        ctx.configState.config.provider.default = result.configPatch.provider.default
      }
    }
    // 向导保存后自动切换当前会话的 provider
    if (result.done && !result.cancelled && result.providerName) {
      await switchActiveProvider(result.providerName)
    }
    return { exit: false }
  }

  if (!normalized) return { exit: false }
  if (normalized === "/") return { exit: false }
  if (["/exit", "/quit", "/q"].includes(normalized)) return { exit: true }

  if (["/help", "/h", "/?"].includes(normalized)) {
    showInfo("help · slash commands and shortcuts", help(providersConfigured), { maxRows: 18 })
    return { exit: false }
  }

  if (["/keys", "/k"].includes(normalized)) {
    showInfo("keyboard shortcuts", shortcutLegend(), { maxRows: 16 })
    return { exit: false }
  }

  if (["/session", "/s"].includes(normalized)) {
    // 单行事实，不值得占一条对话记录
    print(`session=${state.sessionId}`, { channel: "notice", topic: "session" })
    return { exit: false }
  }

  if (["/status"].includes(normalized)) {
    const runtimeView = await buildReplRuntimeSnapshot({
      cwd: process.cwd(),
      state,
      customCommands,
      providers: providersConfigured,
      mcpRegistry: McpRegistry,
      skillRegistry: SkillRegistry,
      recoveryEnabled: ctx.configState.config.session?.recovery !== false
    })
    runtimeView.operatorSnapshot = buildOperatorSnapshot({
      runtimeSummary: runtimeView.runtimeSummary,
      backgroundSummary: runtimeView.backgroundSummary
    })
    // 内容按浮层内宽排版：runtime 视图自己也画框，宽度不匹配时外层折行会把
    // 它的边框折成两段（实测截图里就是 `+-----` 换行成 `---+`）。
    showInfo("runtime status", (innerWidth) => renderRuntimeDashboardView({
      theme: ctx.themeState.theme,
      columns: innerWidth,
      ...runtimeView
    }), { maxRows: 18 })
    return { exit: false }
  }

  if (["/clear", "/cls"].includes(normalized)) {
    return { exit: false, cleared: true }
  }

  if (["/dash", "/dashboard", "/home"].includes(normalized)) {
    const recent = await listSessions({ cwd: process.cwd(), limit: 6, includeChildren: false }).catch(() => [])
    return { exit: false, dashboardRefresh: true, recentSessions: recent }
  }

  if (["/commands"].includes(normalized)) {
    const skills = SkillRegistry.isReady() ? SkillRegistry.list() : []
    const { CustomAgentRegistry } = await import("./agent/custom-agent-loader.mjs")
    const capabilitySnapshot = await buildCapabilitySnapshot({
      mode: state.mode,
      cwd: process.cwd(),
      configState: ctx.configState,
      customCommands,
      skillRegistry: SkillRegistry,
      toolRegistry: ToolRegistry,
      mcpRegistry: McpRegistry,
      listAgents: () => CustomAgentRegistry.list()
    })
    showInfo("commands & capabilities", [
      ...renderInstalledCommandSurface({ customCommands, skills }),
      "",
      ...renderCapabilityPanel(capabilitySnapshot)
    ].join("\n"), { maxRows: 18 })
    return { exit: false }
  }

  if (["/reload"].includes(normalized)) {
    const extensionPolicy = resolveExtensionPolicy(ctx.configState)
    const reloaded = await loadCustomCommands(process.cwd(), {
      allowProjectSources: extensionPolicy.allowProjectSources
    })
    setCustomCommands(reloaded)
    await SkillRegistry.initialize(extensionPolicy.config, process.cwd(), {
      allowProjectSources: extensionPolicy.allowProjectSources
    })
    const { CustomAgentRegistry } = await import("./agent/custom-agent-loader.mjs")
    await CustomAgentRegistry.initialize(process.cwd(), {
      allowProjectSources: extensionPolicy.allowProjectSources
    })
    const skillCount = SkillRegistry.isReady() ? SkillRegistry.list().length : 0
    const agentCount = CustomAgentRegistry.list().length
    print(describeReloadSummary({ commandCount: reloaded.length, skillCount, agentCount }), { channel: "notice", topic: "command" })
    return { exit: false }
  }

  if (["/trust"].includes(normalized)) {
    await persistTrust(process.cwd())
    ctx.trustState = { trusted: true }
    applyWorkspaceTrustPolicy(ctx.configState, ctx.trustState, process.cwd())
    const extensionPolicy = resolveExtensionPolicy(ctx.configState)
    await ToolRegistry.initialize({
      config: extensionPolicy.config,
      cwd: process.cwd(),
      force: true,
      allowProjectSources: extensionPolicy.allowProjectSources
    })
    await SkillRegistry.initialize(extensionPolicy.config, process.cwd(), {
      allowProjectSources: extensionPolicy.allowProjectSources
    })
    const { CustomAgentRegistry } = await import("./agent/custom-agent-loader.mjs")
    await CustomAgentRegistry.initialize(process.cwd(), {
      allowProjectSources: extensionPolicy.allowProjectSources
    })
    await initHookBus(process.cwd(), extensionPolicy.config, {
      allowProjectSources: extensionPolicy.allowProjectSources,
      force: true
    })
    setCustomCommands(await loadCustomCommands(process.cwd(), {
      allowProjectSources: extensionPolicy.allowProjectSources
    }))
    PermissionEngine.setTrusted(true)
    print("workspace trusted", { channel: "notice", topic: "command" })
    return { exit: false }
  }
  if (["/untrust"].includes(normalized)) {
    await revokeTrust(process.cwd())
    ctx.trustState = { trusted: false }
    applyWorkspaceTrustPolicy(ctx.configState, ctx.trustState, process.cwd())
    const extensionPolicy = resolveExtensionPolicy(ctx.configState)
    await ToolRegistry.initialize({
      config: extensionPolicy.config,
      cwd: process.cwd(),
      force: true,
      allowProjectSources: extensionPolicy.allowProjectSources
    })
    await SkillRegistry.initialize(extensionPolicy.config, process.cwd(), {
      allowProjectSources: extensionPolicy.allowProjectSources
    })
    const { CustomAgentRegistry } = await import("./agent/custom-agent-loader.mjs")
    await CustomAgentRegistry.initialize(process.cwd(), {
      allowProjectSources: extensionPolicy.allowProjectSources
    })
    await initHookBus(process.cwd(), extensionPolicy.config, {
      allowProjectSources: extensionPolicy.allowProjectSources,
      force: true
    })
    setCustomCommands(await loadCustomCommands(process.cwd(), {
      allowProjectSources: extensionPolicy.allowProjectSources
    }))
    PermissionEngine.setTrusted(false)
    print("workspace trust revoked — project tools and extensions are now blocked", { channel: "notice", topic: "command" })
    return { exit: false }
  }

  if (["/compact"].includes(normalized)) {
    try {
      print("compacting conversation...")
      const result = await compactSession({
        sessionId: state.sessionId,
        model: state.model,
        providerType: state.providerType,
        configState: ctx.configState
      })
      if (result.compacted) {
        print(`compacted: ${result.summarizedCount} messages summarized, ${result.keptCount} kept`, { channel: "notice", topic: "command" })
      } else {
        print(`skipped: ${result.reason}`, { channel: "notice", topic: "command" })
      }
    } catch (err) {
      print(`compact failed: ${err.message}`, { channel: "notice", topic: "command", tone: "error" })
    }
    return { exit: false }
  }

  if (["/new", "/n"].includes(normalized)) {
    state.sessionId = newSessionId()
    print(`new session: ${state.sessionId}`, { channel: "notice", topic: "command" })
    return { exit: false }
  }

  if (["/history"].includes(normalized)) {
    const sessions = await listSessions({ cwd: process.cwd(), limit: 20, includeChildren: false })
    if (!sessions.length) {
      print("no sessions found", { channel: "notice", topic: "session" })
      return { exit: false }
    }
    const rows = sessions.map((s) => {
      const age = ageLabel(Date.now() - s.updatedAt)
      const title = s.title || `${s.mode}:${s.model || "?"}`
      const titleClipped = title.length > 35 ? title.slice(0, 32) + "..." : title
      return `  ${s.id.slice(0, 12)}  ${padRight(titleClipped, 36)} ${padRight(s.mode, 9)} ${padRight(s.status || "-", 10)} ${age}`
    })
    // 浮层能滚，所以取 20 条而不是 8 条 —— 此前的条数上限是为了不刷屏
    showInfo(`sessions (${sessions.length})`, [
      `  ${padRight("id", 12)}  ${padRight("title", 36)} ${padRight("mode", 9)} ${padRight("status", 10)} age`,
      ...rows,
      "",
      "  /resume <id> 续跑其中一个"
    ].join("\n"))
    return { exit: false }
  }

  if (normalized === "/resume" || normalized.startsWith("/resume ") || normalized === "/r" || normalized.startsWith("/r ")) {
    const arg = normalized.replace(/^\/(resume|r)/, "").trim()
    const sessions = await listSessions({ cwd: process.cwd(), limit: 20, includeChildren: false })

    if (!sessions.length) {
      print("no sessions found in current directory", { channel: "notice", topic: "command", tone: "error" })
      return { exit: false }
    }

    let target = null

    if (!arg) {
      // 裸 /resume 是「列出并选一个」，和 /provider 同构 —— 走选择器，
      // Enter 直接续跑，不必让用户在滚动的对话记录里数编号再手敲。
      const items = sessions.map((session) => {
        const title = session.title || `${session.mode}:${session.model || "?"}`
        const age = ageLabel(Date.now() - session.updatedAt)
        return {
          id: session.id,
          label: title.length > 45 ? `${title.slice(0, 42)}...` : title,
          desc: `${session.mode} · ${session.status || "-"} · ${age}`
        }
      })
      if (openPanel) {
        return { exit: false, openSessionPicker: true, sessionPickerItems: items }
      }
      // 行模式：没有帧可浮，回落到编号列表
      print(`\n  Sessions in ${paint(process.cwd(), "cyan")}:\n`)
      items.forEach((item, i) => {
        const num = paint(`  ${String(i + 1).padStart(2)}.`, "yellow")
        print(`${num} ${padRight(item.label, 46)} ${paint(item.desc, null, { dim: true })}`)
      })
      print(`\n  usage: ${paint("/resume <number>", "yellow")} or ${paint("/resume <session-id>", "yellow")}`)
      return { exit: false }
    }

    // Try numeric index first (1-based)
    const idx = parseInt(arg, 10)
    if (!Number.isNaN(idx) && idx >= 1 && idx <= sessions.length) {
      target = sessions[idx - 1]
    } else {
      // Fallback to ID prefix match
      target = sessions.find((s) => s.id === arg || s.id.startsWith(arg)) || null
    }

    if (!target) {
      print(`no session matching "${arg}"`, { channel: "notice", topic: "command", tone: "error" })
      return { exit: false }
    }

    state.sessionId = target.id
    state.mode = target.mode || state.mode
    state.providerType = target.providerType || state.providerType
    state.model = target.model || state.model
    const title = target.title || `${target.mode}:${target.model || "?"}`
    print(`resumed: ${paint(title, "cyan")} (${target.mode}, ${target.model || "?"})`, { channel: "notice", topic: "command" })
    const msgs = await getConversationHistory(target.id, 3)
    for (const m of msgs) {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content)
      const preview = text.length > 84 ? `${text.slice(0, 84)}...` : text
      print(`  [${m.role}] ${preview}`)
    }
    return { exit: false }
  }

  if (normalized === "/undo") {
    const language = ctx.configState.config.language || "en"
    const cwd = process.cwd()
    const confirmation = await confirmRollback({ cwd, language })
    print(confirmation.message)
    if (!confirmation.confirmed) return { exit: false }
    const result = await executeRollback({
      cwd,
      commitHash: confirmation.commitHash,
      sessionId: state.sessionId,
      language
    })
    print(result.message)
    return { exit: false }
  }

  if (normalized === "/profile" || normalized === "/profile edit") {
    const { loadProfile: lp, runOnboarding: ro } = await import("./onboarding.mjs")
    const current = await lp()
    if (normalized === "/profile" && current) {
      const lines = ["Current profile:"]
      if (current.beginner) {
        lines.push("  mode: beginner (using defaults)")
      } else {
        if (current.languages?.length) lines.push(`  languages: ${current.languages.join(", ")}`)
        if (current.tech_stack?.length) lines.push(`  tech stack: ${current.tech_stack.join(", ")}`)
        if (current.design_style) lines.push(`  style: ${current.design_style}`)
        if (current.extra_notes) lines.push(`  notes: ${current.extra_notes}`)
      }
      lines.push("")
      lines.push("Run /profile edit to update your profile.")
      print(lines.join("\n"))
      return { exit: false }
    }
    if (suspendTui) await suspendTui(ro)
    else await ro()
    return { exit: false }
  }

  if (normalized === "/like") {
    const { runOnboarding: ro } = await import("./onboarding.mjs")
    if (suspendTui) await suspendTui(ro)
    else await ro()
    return { exit: false }
  }

  if (normalized.startsWith("/plan ")) {
    const objective = normalized.replace(/^\/plan\s+/, "").trim()
    state.mode = "plan"
    normalized = [
      "Create a read-only development plan for this request.",
      "Do not edit project source files. Inspect the repository as needed, then call enter_plan and exit_plan with the complete plan.",
      "The plan must include goal, scope, implementation steps, impacted modules, tests, risks, and acceptance criteria.",
      "",
      `Request: ${objective}`
    ].join("\n")
  }

  if (normalized === "/board") {
    // 目标看板：判据 + stage/task 投影成五列（待办/进行中/受阻/待验收/已达成）。
    // 数据来自会话状态与台账 —— 与 `kkcode ultra board` 是同一条码。
    const { LongAgentManager } = await import("./orchestration/longagent-manager.mjs")
    const { loadLedger } = await import("./session/ultra-ledger.mjs")
    const record = await LongAgentManager.get(state.sessionId)
    if (!record?.goal && !record?.stagePlan) {
      print("当前会话还没有 Ultra 目标。用 /ultra 模式跑一个目标后再看。", { channel: "notice", topic: "board", tone: "warn" })
      return { exit: false }
    }
    const ledger = await loadLedger(state.sessionId)
    const lastRound = ledger?.data.rounds[ledger.data.rounds.length - 1]
    const verification = lastRound?.criteria?.length
      ? { results: lastRound.criteria, subGoals: [] }
      : null
    const board = buildBoardModel({
      goal: record.goal, stagePlan: record.stagePlan,
      taskProgress: record.taskProgress || {}, verification
    })
    showInfo("ultra board",
      (innerWidth) => renderUltraBoard(board, { width: Math.max(60, innerWidth), paint }).join("\n"),
      { maxRows: 20 })
    return { exit: false }
  }

  if (["/assistant", "/plan", "/agent", "/code", "/coding", "/longagent", "/ultra", "/yolo"].includes(normalized)) {
    const raw = normalized.slice(1)
    if (raw === "longagent") {
      noteDeprecation("mode.longagent", "`/longagent` 已更名为 `/ultra`")
    }
    const next = switchModeInPlace(state, ctx, raw)
    print(`mode switched: ${next.icon} ${next.label} (${next.hint})`, { channel: "notice", topic: "mode" })
    return { exit: false }
  }

  if (normalized.startsWith("/longagent ") || normalized.startsWith("/ultra ")) {
    const rawSub = normalized.replace(/^\/(longagent|ultra)\s+/, "").trim()
    const sub = rawSub.toLowerCase()
    switchModeInPlace(state, ctx, "ultra")
    if (sub === "4stage" || sub === "hybrid") {
      // 0.4.0 只剩一套 Ultra 编排，impl 子命令不再有意义
      print(`Ultra 现在只有一套编排，/${sub} 子命令已移除`)
      return { exit: false }
    }
    normalized = rawSub
  }

  if (normalized === "/mode" || normalized === "/m") {
    print(`mode: ${formatModeBadge(state.modeId || state.mode)}`, { channel: "notice", topic: "command" })
    return { exit: false, openModePicker: true }
  }

  if (normalized.startsWith("/mode ") || normalized.startsWith("/m ")) {
    const requested = normalized.replace(/^\/(mode|m)\s+/, "").trim()
    const modeId = modeIdFromLegacy(requested)
    if (!modeId) {
      print(`unknown mode: ${escapeTerminalText(requested)} (${MODE_IDS.join(" | ")})`, { channel: "notice", topic: "command", tone: "error" })
      return { exit: false }
    }
    const next = switchModeInPlace(state, ctx, modeId)
    print(`mode switched: ${next.icon} ${next.label} (${next.hint})`, { channel: "notice", topic: "mode" })
    return { exit: false }
  }

  if (normalized === "/provider" || normalized === "/p") {
    // 裸 /provider = 最常用的动作：列出并选择。add/edit 各司其名。
    if (!providersConfigured.length) {
      print("没有已配置的 provider，使用 /provider add 添加。", { channel: "notice", topic: "provider", tone: "warn" })
      return { exit: false }
    }
    const items = providersConfigured.map((name) => {
      const model = ctx.configState.config.provider?.[name]?.default_model || ""
      return { name, label: name, desc: model ? `model: ${model}` : "" }
    })
    // TUI 里这是个选择动作 —— 走可视化选择器，和 /model 一致。
    // 行模式（无 TTY）没有帧可浮，回落到编号输入：先打列表再进选择态。
    if (openPanel) {
      return { exit: false, openProviderPicker: true, providerPickerItems: items }
    }
    print("")
    items.forEach((item, i) => {
      const marker = item.name === state.providerType ? "  ✓ 当前" : ""
      print(`  ${i + 1}. ${item.name}${item.desc ? `  [${item.desc}]` : ""}${marker}`)
    })
    print("")
    print("  输入编号或名称切换（/ 开头的输入会退出选择）")
    print("  /provider add 添加新 provider · /provider edit <名称> 编辑")
    if (setProviderPicker) setProviderPicker(providersConfigured)
    return { exit: false }
  }

  if (normalized.startsWith("/provider ") || normalized.startsWith("/p ")) {
    const rest = normalized.replace(/^\/(provider|p)\s+/, "").trim()

    // /provider add — 添加新 provider（启动向导）。
    // 上游分支里 add 是「列出并切换」而 set 是「添加」—— 与词义相反，
    // 用户想添加 provider 第一反应就是敲 add。归位：add 即添加，
    // 列出并选择归裸 /provider。set 作为一次性别名指路后移除。
    if (rest === "add") {
      if (wizard && setWizard) {
        startWizard(wizard, print)
        setWizard({ ...wizard })
      }
      return { exit: false }
    }
    if (rest === "set") {
      print("`/provider set` 已更名为 `/provider add`（添加新 provider）；列出并切换用裸 `/provider`。")
      return { exit: false }
    }

    // /provider edit <name> — 编辑已有 provider 配置
    if (rest.startsWith("edit ") || rest === "edit") {
      const editName = rest.replace(/^edit\s*/, "").trim()
      if (!editName) {
        print("usage: /provider edit <name>", { channel: "notice", topic: "command", tone: "error" })
        return { exit: false }
      }
      const providerCfg = ctx.configState.config?.provider?.[editName]
      if (!providerCfg || typeof providerCfg !== "object") {
        print(`provider "${editName}" 未找到，可用: ${providersConfigured.join(", ")}`, { channel: "notice", topic: "command", tone: "error" })
        return { exit: false }
      }
      if (wizard && setWizard) {
        startEditWizard(wizard, editName, providerCfg, print)
        setWizard({ ...wizard })
      }
      return { exit: false }
    }

    // /provider <name> — 切换 provider
    const next = rest
    if (!providersConfigured.includes(next)) {
      print(`provider must be one of: ${providersConfigured.join(", ")}`, { channel: "notice", topic: "command", tone: "error" })
      return { exit: false }
    }
    await switchActiveProvider(next)
    return { exit: false }
  }

  if (normalized === "/model" || normalized === "/model refresh") {
    const refresh = normalized.endsWith(" refresh")
    print(`current: ${state.providerType} / ${state.model}`)
    const catalog = await loadProviderModelItems(ctx.configState, state.providerType, { refresh })
    const items = catalog.items
    if (items.length) {
      print("")
      print(`  可用模型 (${catalog.source}${catalog.stale ? ", stale" : ""})：`)
      for (const item of items) {
        const marker = (item.provider === state.providerType && item.model === state.model) ? " ●" : ""
        print(`    ${item.label}${marker}`)
      }
      print("")
      print("  用法: /model <model-id>，/model refresh 刷新目录")
    } else {
      print(`  模型目录不可用${catalog.error ? `: ${catalog.error}` : ""}`)
      print("  使用 /model <model-id> 手动设置；离线列表需在 provider.models 中由用户显式配置。")
    }
    if (catalog.warning) print(`  模型目录提示: ${catalog.warning}`)
    return {
      exit: false,
      openModelPicker: items.length > 0,
      modelPickerItems: items
    }
  }

  if (normalized.startsWith("/model ")) {
    const next = normalized.replace("/model ", "").trim()
    if (!next) print("usage: /model <model-id>", { channel: "notice", topic: "command", tone: "error" })
    else {
      try {
        state.model = validateModelId(next)
        print(`model switched: ${escapeTerminalText(state.model)}`, { channel: "notice", topic: "switch" })
      } catch (error) {
        print(`invalid model id: ${escapeTerminalText(error.message)}`, { channel: "notice", topic: "command", tone: "error" })
      }
    }
    return { exit: false }
  }

  if (normalized === "/permission" || normalized.startsWith("/permission ")) {
    const tokens = normalized.split(/\s+/).slice(1)
    const sub = (tokens[0] || "show").toLowerCase()
    const permission = ctx.configState.config.permission || (ctx.configState.config.permission = {})

    if (sub === "show") {
      // 档位、非交互默认值、以及当前生效的规则一起给全 —— 此前只打两行档位，
      // 想看规则还要另外记得 /permission list。
      const all = Array.isArray(permission.rules) ? permission.rules : []
      const learned = listLearnedRules(all)
      const manual = all.filter((rule) => !isLearnedRule(rule))
      const lines = [
        `level:    ${normalizePermissionLevel(permission)}`,
        `non_tty:  ${permission.non_tty_default || "deny"}`,
        ""
      ]
      if (manual.length) {
        lines.push(`configured rules (${manual.length}):`)
        for (const rule of manual) lines.push(`  ${escapeTerminalText(describeRule(rule))}`)
        lines.push("")
      }
      if (learned.length) {
        lines.push(`always-allow rules (${learned.length}) — /permission forget <n>:`)
        for (const [index, rule] of learned.entries()) {
          lines.push(`  [${index}] ${escapeTerminalText(describeRule(rule))}`)
        }
        lines.push("")
      }
      if (!all.length) lines.push("no permission rules configured", "")
      lines.push("  /permission <readonly|manual|accept-edits|yolo> 切档 · /permission save 落盘")
      showInfo("permission", lines.join("\n"), { maxRows: 18 })
      return { exit: false, openPolicyPicker: true }
    }

    if (sub === "cycle") {
      // Shift+Tab 在 0.4.0 改切模式，审批档单独用这条命令循环
      const next = nextPermissionLevel(permission)
      ctx.configState.config.permission = applyPermissionLevel(next, permission)
      print(`permission.level -> ${next} (runtime)`, { channel: "notice", topic: "permission" })
      return { exit: false }
    }

    if (sub === "list" || sub === "rules") {
      const all = Array.isArray(permission.rules) ? permission.rules : []
      const learned = listLearnedRules(all)
      const manual = all.filter((rule) => !isLearnedRule(rule))
      if (!all.length) {
        print("no permission rules configured", { channel: "notice", topic: "permission" })
        return { exit: false }
      }
      const lines = []
      if (manual.length) {
        lines.push(`configured rules (${manual.length}):`)
        for (const rule of manual) lines.push(`  ${escapeTerminalText(describeRule(rule))}`)
        if (learned.length) lines.push("")
      }
      if (learned.length) {
        lines.push(`always-allow rules (${learned.length}) — /permission forget <n>:`)
        for (const [index, rule] of learned.entries()) {
          lines.push(`  [${index}] ${escapeTerminalText(describeRule(rule))}`)
        }
      }
      showInfo(`permission rules (${all.length})`, lines.join("\n"), { maxRows: 18 })
      return { exit: false }
    }

    if (sub === "forget") {
      const arg = String(tokens[1] || "").toLowerCase()
      const all = arg === "--learned" || arg === "all"
      if (!all && !/^\d+$/.test(arg)) {
        print("usage: /permission forget <n|all>", { channel: "notice", topic: "command", tone: "error" })
        return { exit: false }
      }
      const outcome = removeLearnedRules(permission.rules, all ? { all: true } : { index: Number(arg) })
      if (!outcome.removed.length) {
        print("no matching always-allow rule", { channel: "notice", topic: "command", tone: "error" })
        return { exit: false }
      }
      permission.rules = outcome.rules
      try {
        const target = pickConfigPathForScope("user", ctx.configState?.source, process.cwd())
        const existing = await readConfigFile(target)
        const persisted = removeLearnedRules(existing?.permission?.rules, all ? { all: true } : { index: Number(arg) })
        await writeConfigFile(target, {
          ...existing,
          permission: { ...(existing.permission || {}), rules: persisted.rules }
        })
        print(`forgot ${outcome.removed.length} always-allow rule(s) -> ${target}`, { channel: "notice", topic: "permission" })
      } catch (error) {
        print(`forgot ${outcome.removed.length} rule(s) in this session, but saving failed: ${escapeTerminalText(error.message)}`)
      }
      return { exit: false }
    }

    if (approvalFromLegacy(sub)) {
      const applied = applyPermissionLevel(sub, permission)
      ctx.configState.config.permission = applied
      print(applied.level === sub
        ? `permission.level -> ${applied.level} (runtime)`
        : `permission.level -> ${applied.level} (runtime, ${sub} 已合并为 ${applied.level})`,
        { channel: "notice", topic: "permission" })
      return { exit: false }
    }

    if (["ask", "allow", "deny"].includes(sub)) {
      // 0.3.x 这里只写 mode/default_policy，而判定链只看 level，实际是静默 no-op。
      const mapped = sub === "allow" ? "accept-edits" : sub === "deny" ? "readonly" : "manual"
      ctx.configState.config.permission = applyPermissionLevel(mapped, permission)
      print(`/permission ${sub} 已弃用，已映射为 permission.level -> ${mapped} (runtime)`)
      return { exit: false }
    }

    if (sub === "non-tty") {
      const value = String(tokens[1] || "").toLowerCase()
      if (!["allow_once", "deny"].includes(value)) {
        print("usage: /permission non-tty <allow_once|deny>", { channel: "notice", topic: "command", tone: "error" })
        return { exit: false }
      }
      permission.non_tty_default = value
      print(`permission.non_tty_default -> ${value} (runtime)`, { channel: "notice", topic: "permission" })
      return { exit: false }
    }

    if (sub === "save") {
      const scope = String(tokens[1] || "project").toLowerCase()
      if (!["project", "user"].includes(scope)) {
        print("usage: /permission save [project|user]", { channel: "notice", topic: "command", tone: "error" })
        return { exit: false }
      }
      try {
        const target = await persistPermissionConfig({
          scope,
          ctx,
          values: {
            level: normalizePermissionLevel(permission),
            non_tty_default: permission.non_tty_default || "deny"
          }
        })
        print(`permission saved (${scope}) -> ${target}`, { channel: "notice", topic: "command" })
      } catch (error) {
        print(`permission save failed: ${error.message}`, { channel: "notice", topic: "command", tone: "error" })
      }
      return { exit: false }
    }

    if (sub === "session-clear" || sub === "reset") {
      PermissionEngine.clearSession(state.sessionId)
      print(`permission session cache cleared: ${state.sessionId}`, { channel: "notice", topic: "command" })
      return { exit: false }
    }

    print("usage: /permission [show|readonly|review|auto|edit|full-auto|yolo|non-tty <allow_once|deny>|save [project|user]|session-clear]")
    return { exit: false }
  }

  // /paste — read clipboard image, optionally with prompt text
  if (normalized === "/paste" || normalized.startsWith("/paste ")) {
    const pasteText = normalized.replace(/^\/paste\s*/, "").trim()
    print("reading clipboard...")
    const clipBlock = await readClipboardImage({ onStatus: (msg) => { if (msg) print(msg) } })
    if (!clipBlock || clipBlock.type === "error") {
      print(clipBlock?.message ? `paste failed: ${clipBlock.message}` : "no image found in clipboard")
      return { exit: false }
    }
    if (!pasteText) {
      // Just attach — store for next message
      pendingImages.push(clipBlock)
      print(`image pasted from clipboard (${pendingImages.length} image(s) attached, send a message to include)`, { channel: "notice", topic: "command" })
      return { exit: false, pastedImage: true }
    }
    // Has text — send immediately with the image
    const allImages = [...pendingImages, clipBlock]
    if (clearPendingImages) clearPendingImages()
    const turn = await executePromptTurn({
      prompt: pasteText,
      state,
      ctx,
      streamSink: state.mode === "longagent" ? null : streamSink,
      pendingImages: allImages,
      signal
    })
    const result = turn.result
    const status = renderReplStatusLine({
      state,
      configState: ctx.configState,
      theme: ctx.themeState.theme,
      tokenMeter: result.tokenMeter,
      cost: result.cost,
      costSavings: result.costSavings,
      contextMeter: result.context,
      longagentState: result.longagent
    })
    if (showTurnStatus) print(status)
    if (!result.emittedText) {
      const mdEnabled = ctx.configState.config.ui?.markdown_render !== false
      print(mdEnabled ? renderMarkdown(result.reply) : result.reply)
    }
    return { exit: false, turnResult: { tokenMeter: result.tokenMeter, cost: result.cost, costSavings: result.costSavings, context: result.context, longagent: result.longagent, toolEvents: result.toolEvents } }
  }

  // /create-skill — AI generates a new skill from description
  if (normalized === "/create-skill" || normalized.startsWith("/create-skill ")) {
    const description = normalized.replace(/^\/create-skill\s*/, "").trim()
    if (!description) {
      print("usage: /create-skill <description of what the skill should do>", { channel: "notice", topic: "command", tone: "error" })
      print("example: /create-skill review code for security vulnerabilities")
      return { exit: false }
    }
    print(`generating skill: ${description}`)
    try {
      const skill = await generateSkill({
        description,
        configState: ctx.configState,
        providerType: state.providerType,
        model: state.model,
        baseUrl: null,
        apiKeyEnv: null
      })
      if (!skill) {
        print("skill generation failed — no output from model", { channel: "notice", topic: "command", tone: "error" })
        return { exit: false }
      }
      print(`--- ${skill.filename} ---`)
      print(skill.content)
      print("---")
      const savedPath = await saveSkillGlobal(skill.filename, skill.content)
      print(`saved to: ${savedPath}`)
      // Reload skills
      const extensionPolicy = resolveExtensionPolicy(ctx.configState)
      await SkillRegistry.initialize(extensionPolicy.config, process.cwd(), {
        allowProjectSources: extensionPolicy.allowProjectSources
      })
      print(`skill /${skill.name} is now available`, { channel: "notice", topic: "command" })
    } catch (error) {
      print(`skill generation error: ${error.message}`, { channel: "notice", topic: "command", tone: "error" })
    }
    return { exit: false }
  }

  // /create-agent — AI generates a new sub-agent from description
  if (normalized === "/agents") {
    // CLI 侧一直有 `kkcode agent list`，REPL 里却看不到子智能体的存在与权限档。
    const { listAgents } = await import("./agent/agent.mjs")
    const configured = ctx.configState.config.agent?.subagents || {}
    const rows = listAgents()
      .filter((agent) => agent.mode === "subagent")
      .map((agent) => {
        const override = configured[agent.name]
        const permission = override?.permission || agent.permission || "default"
        const tools = (override?.tools || agent.tools)
        return `  ${agent.name.padEnd(20)} ${String(permission).padEnd(10)} ${tools ? `tools: ${tools.join(", ")}` : "tools: all"}`
      })
    showInfo(`subagents (${rows.length})`, ["subagents (name / permission / tools)", ...rows].join("\n"))
    return { exit: false }
  }

  if (normalized === "/tasks" || normalized.startsWith("/tasks ")) {
    const { BackgroundManager } = await import("./orchestration/background-manager.mjs")
    const rest = normalized.slice("/tasks".length).trim()
    const [action, taskId] = rest.split(/\s+/).filter(Boolean)
    if (action === "stop" && taskId) {
      await BackgroundManager.cancel(taskId).catch(() => null)
      print(`task ${taskId} cancellation requested`, { channel: "notice", topic: "task" })
      return { exit: false }
    }
    if (action === "retry" && taskId) {
      const retried = await BackgroundManager.retry(taskId, ctx.configState.config).catch(() => null)
      print(retried ? `task ${taskId} retried (attempt ${retried.attempt})` : `task ${taskId} could not be retried`,
        { channel: "notice", topic: "task", tone: retried ? "success" : "warn" })
      return { exit: false }
    }
    const tasks = await BackgroundManager.list().catch(() => [])
    if (!tasks.length) {
      print("no background tasks", { channel: "notice", topic: "task" })
      return { exit: false }
    }
    const rows = tasks.slice(-20).map((task) => {
      const desc = String(task.description || "").slice(0, 48)
      return `  ${String(task.id).padEnd(24)} ${String(task.status).padEnd(12)} ${desc}`
    })
    showInfo(`background tasks (${tasks.length})`,
      ["background tasks (id / status / description)", ...rows, "", "  /tasks stop <id> · /tasks retry <id>"].join("\n"))
    return { exit: false }
  }

  if (normalized === "/create-agent" || normalized.startsWith("/create-agent ")) {
    const description = normalized.replace(/^\/create-agent\s*/, "").trim()
    if (!description) {
      print("usage: /create-agent <description of what the agent should do>", { channel: "notice", topic: "command", tone: "error" })
      print("example: /create-agent code reviewer that focuses on security vulnerabilities")
      return { exit: false }
    }
    print(`generating agent: ${description}`)
    try {
      const { generateAgent, saveAgentGlobal } = await import("./agent/generator.mjs")
      const agent = await generateAgent({
        description,
        configState: ctx.configState,
        providerType: state.providerType,
        model: state.model,
        baseUrl: null,
        apiKeyEnv: null
      })
      if (!agent) {
        print("agent generation failed — no output from model", { channel: "notice", topic: "command", tone: "error" })
        return { exit: false }
      }
      print(`--- ${agent.filename} ---`)
      print(agent.content)
      print("---")
      const savedPath = await saveAgentGlobal(agent.filename, agent.content)
      print(`saved to: ${savedPath}`)
      // Reload custom agents
      const { CustomAgentRegistry } = await import("./agent/custom-agent-loader.mjs")
      const extensionPolicy = resolveExtensionPolicy(ctx.configState)
      await CustomAgentRegistry.initialize(process.cwd(), {
        allowProjectSources: extensionPolicy.allowProjectSources
      })
      print(`agent "${agent.name}" is now available as a sub-agent`, { channel: "notice", topic: "command" })
    } catch (error) {
      print(`agent generation error: ${error.message}`, { channel: "notice", topic: "command", tone: "error" })
    }
    return { exit: false }
  }

  let prompt = normalized
  if (normalized.startsWith("$") || normalized.startsWith("/")) {
    const sigil = normalized.startsWith("$") ? "$" : "/"
    const body = normalized.slice(1)
    const [name, ...argTokens] = body.split(/\s+/)
    const args = argTokens.join(" ").trim()

    const skill = SkillRegistry.isReady() ? SkillRegistry.get(name) : null
    if (sigil === "$" || skill) {
      if (!skill) {
        print(`unknown skill: $${name}`, { channel: "notice", topic: "command", tone: "error" })
        return { exit: false }
      }
      const expanded = await SkillRegistry.execute(name, args, {
        cwd: process.cwd(),
        mode: state.mode,
        model: state.model,
        provider: state.providerType,
        config: ctx.configState?.config || null
      })
      if (!expanded) {
        print(`skill $${name} returned no output`, { channel: "notice", topic: "command", tone: "error" })
        return { exit: false }
      }
      // contextFork skills return { prompt, contextFork, model }
      if (typeof expanded === "object" && expanded.contextFork) {
        prompt = expanded.prompt || ""
        if (expanded.model) state.model = expanded.model
      } else {
        prompt = expanded
      }
    } else {
      // Fallback: check raw custom commands (in case SkillRegistry not ready)
      const custom = customCommands.find((item) => item.name === name)
      if (!custom) {
        print(`unknown slash command: /${name}`, { channel: "notice", topic: "command", tone: "error" })
        return { exit: false }
      }
      prompt = applyCommandTemplate(custom.template, args, {
        path: process.cwd(),
        mode: state.mode,
        provider: state.providerType,
        cwd: process.cwd(),
        project: basename(process.cwd())
      })
    }
  }

  // Include any pending clipboard images with this message
  const images = pendingImages.length ? [...pendingImages] : []
  if (clearPendingImages && images.length) clearPendingImages()

  const turn = await executePromptTurn({
    prompt,
    state,
    ctx,
    streamSink: state.mode === "longagent" ? null : streamSink,
    pendingImages: images,
    signal
  })
  const result = turn.result

  const status = renderReplStatusLine({
    state,
    configState: ctx.configState,
    theme: ctx.themeState.theme,
    tokenMeter: result.tokenMeter,
    cost: result.cost,
    costSavings: result.costSavings,
    contextMeter: result.context,
    longagentState: result.longagent
  })
  if (showTurnStatus) print(status)

  const toolFileChanges = normalizeFileChanges(result.toolEvents)
  const longagentFileChanges = normalizeFileChanges(
    Array.isArray(result.longagent?.fileChanges)
      ? result.longagent.fileChanges.map((item) => ({
          name: "write",
          metadata: { fileChanges: [item] }
        }))
      : []
  )
  const fileChanges = state.mode === "longagent" && longagentFileChanges.length
    ? longagentFileChanges
    : toolFileChanges
  const diagnostics = normalizeDiagnostics(result.toolEvents)

  if (state.mode === "longagent") {
    if (result.longagent) {
      if (result.longagent.goal) {
        // 0.5.0：目标看板的紧凑形态（每个子目标一行进度 + 受阻/待验收计数），
        // 取代旧的 "longagent: phase=… stage=…" 单行
        const board = buildBoardModel({
          goal: result.longagent.goal,
          stagePlan: result.longagent.stagePlan,
          taskProgress: result.longagent.taskProgress || {},
          verification: result.longagent.goalVerification
        })
        for (const line of renderUltraBoard(board, { compact: true, paint })) print(line)
      } else {
        const stg = result.longagent.currentStageId
          ? result.longagent.currentStageId
          : `${(result.longagent.stageIndex || 0) + 1}/${Math.max(1, result.longagent.stageCount || 1)}`
        print(`longagent: phase=${result.longagent.phase || "-"} stage=${stg} gate=${result.longagent.currentGate || "-"}`)
      }
      if (result.longagent.taskProgress && Object.keys(result.longagent.taskProgress).length) {
        for (const line of renderTaskProgressPanel(result.longagent.taskProgress, formatPlanProgress)) print(line)
      }
      // 受阻报告优先（从 ledger 生成的结构化报告，带判据与证据）；
      // 没有报告时退回 recoverySuggestions —— 后者从 0.3.x 起就在生成，
      // 但 engine 打包时没有透传，全代码库零消费者，用户从来没见过它。
      if (result.longagent.blockedReport && result.longagent.status !== "completed") {
        for (const line of renderBlockedReportText(result.longagent.blockedReport, { paint })) print(line)
      } else if (result.longagent.recoverySuggestions) {
        for (const line of formatRecoverySuggestions(result.longagent.recoverySuggestions)) print(line)
      }
    }
    if (fileChanges.length) {
      print(paint("changed files:", "cyan", { bold: true }))
      for (const line of renderFileChangeLines(fileChanges)) print(line)
    }
    if (diagnostics.length) {
      print(paint("diagnostics:", "yellow", { bold: true }))
      for (const line of renderDiagnosticsLines(diagnostics, 6)) print(line)
    } else if (!result.emittedText && result.reply) {
      const mdEnabled = ctx.configState.config.ui?.markdown_render !== false
      print(mdEnabled ? renderMarkdown(result.reply) : result.reply)
    }
  } else {
    if (!result.emittedText) {
      const mdEnabled = ctx.configState.config.ui?.markdown_render !== false
      print(mdEnabled ? renderMarkdown(result.reply) : result.reply)
    }
    if (fileChanges.length) {
      print(paint("changed files:", "cyan", { bold: true }))
      for (const line of renderFileChangeLines(fileChanges, 10)) print(line)
    }
    if (diagnostics.length) {
      print(paint("diagnostics:", "yellow", { bold: true }))
      for (const line of renderDiagnosticsLines(diagnostics, 6)) print(line)
    }
  }
  // Plan 审批选择了执行航道 → 真正切模式（0.3.x 只把选择塞回提示词）
  let planHandoff = null
  if (result.planHandoff?.modeId) {
    const next = switchModeInPlace(state, ctx, result.planHandoff.modeId)
    planHandoff = { ...result.planHandoff, label: next.label, icon: next.icon }
    print(`mode switched: ${next.icon} ${next.label} (plan build)`, { channel: "notice", topic: "mode" })
  }

  return {
    exit: false,
    planHandoff,
    turnResult: {
      tokenMeter: result.tokenMeter,
      cost: result.cost,
      context: result.context,
      longagent: result.longagent,
      toolEvents: result.toolEvents
    }
  }
}

async function startLineRepl({ ctx, state, providersConfigured, customCommands, recentSessions, historyLines }) {
  const rl = createInterface({ input, output, history: historyLines, historySize: HIST_SIZE })
  let localCustomCommands = customCommands
  let localWizard = createWizardState()
  let localProviderPicker = null
  const entered = [...historyLines]
  const lastTurn = {
    tokenMeter: {
      estimated: false,
      turn: { input: 0, output: 0 },
      session: { input: 0, output: 0 },
      global: { input: 0, output: 0 }
    },
    cost: 0,
    context: null,
    longagent: null
  }

  console.log(renderStartupScreen({
    theme: ctx.themeState.theme,
    recentSessions,
    columns: Number(process.stdout.columns || 120)
  }))

  const lineActivityRenderer = createActivityRenderer({
    theme: ctx.themeState.theme,
    output: {
      appendLog: (text) => console.log(text),
      appendStreamChunk: (chunk) => process.stdout.write(chunk)
    }
  })
  lineActivityRenderer.start()

  let linePendingImages = []

  while (true) {
    const status = renderReplStatusLine({
      state,
      configState: ctx.configState,
      theme: ctx.themeState.theme,
      tokenMeter: lastTurn.tokenMeter,
      cost: lastTurn.cost,
      costSavings: lastTurn.costSavings,
      contextMeter: lastTurn.context,
      longagentState: lastTurn.longagent
    })

    const line = await collectInput(rl, `${status}\n> `)
    if (!line) continue
    entered.push(line)

    // `|| {}` 不是防御性冗余：调用点直接读 action 的字段，而命令分支曾经
    // 返回过裸 null（/agents、/tasks，v0.6.0 起），行模式这条 while 循环没有
    // try/catch，于是整个 REPL 崩在下一行的 action.cleared 上。归一化让
    // 「某个分支忘了返回对象」退化成无害的默认动作。
    const action = (await processInputLine({
      line,
      state,
      ctx,
      providersConfigured,
      customCommands: localCustomCommands,
      setCustomCommands: (next) => {
        localCustomCommands = next
      },
      wizard: localWizard,
      setWizard: (next) => { localWizard = next },
      providerPicker: localProviderPicker,
      setProviderPicker: (next) => { localProviderPicker = next },
      print: (text) => console.log(text),
      pendingImages: linePendingImages,
      clearPendingImages: () => { linePendingImages = [] }
    })) || {}

    if (action.cleared) clearScreen()
    if (action.dashboardRefresh) {
      const runtimeView = await buildReplRuntimeSnapshot({
        cwd: process.cwd(),
        state,
        customCommands: localCustomCommands,
        providers: providersConfigured,
        mcpRegistry: McpRegistry,
        skillRegistry: SkillRegistry,
        recoveryEnabled: ctx.configState.config.session?.recovery !== false
      })
      runtimeView.recentSessions = action.recentSessions || runtimeView.recentSessions
      console.log(
        renderReplDashboard({
          theme: ctx.themeState.theme,
          ...runtimeView
        })
      )
    }

    if (action.turnResult) {
      lastTurn.tokenMeter = action.turnResult.tokenMeter || lastTurn.tokenMeter
      lastTurn.cost = Number.isFinite(action.turnResult.cost) ? action.turnResult.cost : lastTurn.cost
      lastTurn.context = action.turnResult.context || null
      lastTurn.longagent = action.turnResult.longagent || null
    }

    if (action.exit) break
  }

  lineActivityRenderer.stop()
  rl.close()
  await saveHistoryLines(HIST_FILE, HIST_SIZE, entered)
}

function startTuiFrame(features) {
  output.write(enterTerminalSequence(features))
}

function stopTuiFrame(features) {
  output.write(exitTerminalSequence(features))
}

function hasShiftEnterSequence(dataChunk) {
  const text = Buffer.isBuffer(dataChunk) ? dataChunk.toString("utf8") : String(dataChunk || "")
  if (!text || text.length < 2) return false
  return (
    text.includes("\x1b[13;2u") ||
    text.includes("\x1b[27;2;13~") ||
    text.includes("\x1b[13;2~")
  )
}

function isCommandLikeInput(line) {
  const value = String(line || "").trimStart()
  return value.startsWith("/") || value.startsWith("$")
}


async function startTuiRepl({ ctx, state, providersConfigured, customCommands, recentSessions, historyLines, mcpStatusLines = [] }) {
  let localCustomCommands = customCommands
  let localRecentSessions = recentSessions
  const terminalFeatures = resolveTerminalFeatures(ctx.configState.config.ui?.terminal || {})
  const transcript = createTranscriptModel({ maxItems: MAX_TUI_LOG_LINES })
  const toastStore = createToastStore({
    durationMs: Number(ctx.configState.config.ui?.terminal?.toast_duration_ms || 2600),
    maxToasts: 3
  })
  for (const line of mcpStatusLines) transcript.appendLog(sanitizeTerminalStyledText(line))

  const ui = {
    input: "",
    inputCursor: 0,
    busy: false,
    pendingImages: [],
    permissionQueue: [],
    pendingPermission: null,
    permissionSelected: 0,
    questionQueue: [],
    pendingQuestion: null,
    lastEscapeAt: 0,
    questionIndex: 0,
    questionOptionSelected: 0,
    questionMultiSelected: {},
    questionCustomMode: false,
    questionCustomInput: "",
    questionCustomCursor: 0,
    questionAnswers: {},
    modelPicker: null,
    policyPicker: null,
    modePicker: null,
    selectedSuggestion: 0,
    suggestionOffset: 0,
    history: [...historyLines],
    historyIndex: historyLines.length,
    scrollOffset: 0,
    quitting: false,
    showDashboard: true,
    scrollMeta: {
      logRows: 0,
      totalRows: 0,
      maxOffset: 0
    },
    spinnerIndex: 0,
    currentActivity: null,
    currentStep: 0,
    maxSteps: 0,
    thinking: createThinkingState(),
    lastThinkingId: null,
    streamLogId: null,
    streamRaw: "",
    appState: createAppState(),
    activeTurnId: null,
    paused: false,
    turnAbortController: null,
    lastCtrlCTime: 0,
    agentContinuation: null,
    lastLongAgentPrompt: null,
    longagentAborted: false,
    agentTransaction: null,
    agentAborted: false,
    pendingModeConfirm: null,
    // 鼠标文本选择状态
    mouseSelection: null,  // { startRow, startCol, endRow, endCol, active }
    autoCopy: terminalFeatures.copyOnSelect, // 全屏鼠标模式下默认选中即复制
    inputSelection: null,  // { start, end } 输入框内的选择范围（字符位置）
    inputDragAnchor: -1,   // 输入框拖拽起始字符位置
    ghostText: "",         // 小模型预测的下一句（纯视觉，不参与光标计算）
    inputLayout: null,
    // 屏幕布局元数据（buildFrame 中更新）
    layoutMeta: { logStartRow: 0, logEndRow: 0, inputStartRow: 0, inputEndRow: 0 },
    wizard: createWizardState(),
    providerPicker: null,
    sessionPicker: null,
    // 只读信息浮层：{ title, lines, offset, maxOffset, maxRows }
    // 与选择器互斥 —— 打开它时不该同时有别的浮层抢屏。
    infoPanel: null,
    metrics: {
      tokenMeter: {
        estimated: false,
        turn: { input: 0, output: 0 },
        session: { input: 0, output: 0 },
        global: { input: 0, output: 0 }
      },
      cost: null,
      context: null,
      longagent: null,
      toolEvents: []
    }
  }
  let lastFrame = []
  let lastFrameWidth = 0
  let forceFullPaint = true
  let renderScheduled = false
  let renderTimer = null
  let spinnerTimer = null
  let selectionClearTimer = null
  // 拖选到日志区边缘外时的自动滚动定时器
  let autoScrollTimer = null
  let autoScrollState = null
  let protocolFlushTimer = null
  let clipboardAbortController = null
  let disposed = false
  let terminalSuspended = true
  let terminalFrameActive = false
  let keypressDecoderStarted = false
  let stdinEmitPatched = false
  let rawModeActive = false
  let jobControlSuspended = false
  let resumeTerminalAfterContinue = false
  let resumeSpinnerAfterContinue = false
  let onResize = null
  let onKey = null
  let onData = null
  let onSigint = null
  let onTerminate = null
  let onSigbreak = null
  let onProcessExit = null
  let onSuspend = null
  let onContinue = null

  function sanitizeTranscriptRecord(input, options = {}) {
    const source = input && typeof input === "object" && !Array.isArray(input)
      ? { ...input, ...options }
      : { ...options, summary: String(input ?? "").replace(/\r/g, "") }
    const safe = sanitizeTerminalValue(source)
    for (const key of ["summary", "title", "text"]) {
      if (source[key] !== undefined) safe[key] = sanitizeTerminalStyledText(source[key])
    }
    if (source.details !== undefined) {
      const details = Array.isArray(source.details) ? source.details : [source.details]
      safe.details = details.flatMap((line) =>
        sanitizeTerminalStyledText(line).split(/\r?\n/)
      )
    }
    return safe
  }

  function appendLog(text = "", options = {}) {
    const follow = ui.scrollOffset === 0
    const id = transcript.appendLog(sanitizeTranscriptRecord(text, options))
    if (follow) ui.scrollOffset = 0
    return id
  }

  /**
   * 命令输出的通道。
   *
   * 0.6.0 之前这里靠**正则嗅探**决定一条消息是瞬时提示还是对话记录 ——
   * 只认四个英文动词加 "switched:"，中文文案与多行输出一律漏网，于是
   * /help（80+ 行）、/status、/board 的看板全都灌进对话记录，还会被
   * /clear 一起清掉。现在由调用点显式声明意图。
   *
   * @param {string} text
   * @param {{channel?: "transcript"|"notice"|"panel", topic?: string, tone?: string, title?: string}} options
   */
  function printTui(text = "", options = {}) {
    const channel = options.channel || "transcript"
    if (channel === "notice") {
      showToast(stripAnsi(text).trim(), {
        topic: options.topic || "status",
        tone: options.tone || "success"
      })
      return null
    }
    if (channel === "panel") {
      // 面板类输出（帮助、状态、看板）折叠成一条可展开的条目：占一行，
      // 展开才铺开，既不刷屏也不丢内容。
      const lines = String(text).split("\n")
      return appendLog({
        summary: options.title || lines[0] || "output",
        details: lines.length > 1 ? lines.slice(options.title ? 0 : 1) : [],
        kind: "system",
        collapsible: lines.length > 1
      })
    }
    return appendLog(text)
  }

  function updateLog(id, patch) {
    if (!patch || typeof patch !== "object") return transcript.updateLog(id, patch)
    return transcript.updateLog(id, sanitizeTranscriptRecord(patch))
  }

  function showToast(message, {
    topic = "status",
    tone = "info",
    durationMs
  } = {}) {
    return toastStore.show(sanitizeTerminalText(message), { topic, tone, durationMs })
  }

  /**
   * 回溯上一轮对话。撤回的那句输入会填回输入框 —— 「退回去改一下再问」
   * 应该是一步，而不是先退再重打一遍。
   */
  async function handleRewind() {
    if (ui.busy) {
      showToast("正在生成中，先按 Esc 中断", { topic: "rewind", tone: "warning" })
      return
    }
    try {
      const result = await rewindLastTurn(state.sessionId)
      if (!result.ok) {
        showToast(result.reason === "empty_session" ? "会话是空的，没有可回溯的内容" : "没有可回溯的轮次", {
          topic: "rewind",
          tone: "info"
        })
        return
      }
      // 对话记录同步回退到上一条用户输入之前（含它本身）
      const items = transcript.getItems()
      const lastUserIndex = items.findLastIndex((item) => item.kind === "user")
      if (lastUserIndex >= 0) {
        for (const item of items.slice(lastUserIndex)) transcript.removeLog(item.id)
      }

      if (result.prompt) {
        ui.input = result.prompt
        ui.inputCursor = result.prompt.length
      }
      showToast(`已回溯一轮（${result.removed} 条消息）· 文件改动请用 /undo`, {
        topic: "rewind",
        tone: "success"
      })
    } catch (error) {
      showToast(`回溯失败：${error?.message || error}`, { topic: "rewind", tone: "error" })
    }
    requestRender()
  }

  function appendStreamChunk() {
    // Provider text/thinking is consumed from typed EventBus deltas below.
    // Keeping the sink avoids direct stdout writes while the TUI owns the
    // screen and prevents a second Markdown rendering pass.
  }

  function renderToastLine() {
    const toast = toastStore.getToasts({ pruneExpired: false }).at(-1)
    if (!toast) return null
    const palette = {
      success: ctx.themeState.theme.semantic.success,
      warning: ctx.themeState.theme.semantic.warn,
      error: ctx.themeState.theme.semantic.error,
      info: ctx.themeState.theme.semantic.info
    }
    const symbols = { success: "✓", warning: "!", error: "✗", info: "●" }
    const tone = toast.tone in palette ? toast.tone : "info"
    return `${paint(symbols[tone], palette[tone], { bold: true })} ${paint(toast.message, palette[tone])}`
  }

  function applyThinkingTransition(transition) {
    ui.thinking = transition.state
    if (!transition.completed) return null
    const item = buildThinkingTranscriptItem({
      ...transition.completed,
      raw: sanitizeTerminalText(transition.completed.raw)
    })
    const id = appendLog(
      paint(item.summary, "#8a8a8a", { dim: true }),
      {
        ...item,
        details: item.details.map((line) => paint(`  ${line}`, "#777777"))
      }
    )
    ui.lastThinkingId = id
    return id
  }

  function finalizeThinking(now = Date.now()) {
    return applyThinkingTransition(finishThinkingState(ui.thinking, { now }))
  }

  function renderTextStreamFrame() {
    if (!ui.streamLogId && !ui.streamRaw) return
    const rendered = ctx.configState.config.ui?.markdown_render !== false
      ? renderMarkdown(ui.streamRaw)
      : sanitizeTerminalText(ui.streamRaw)
    if (!ui.streamLogId) {
      ui.streamLogId = appendLog(rendered, { kind: "assistant", status: "streaming" })
    } else {
      updateLog(ui.streamLogId, { summary: rendered, status: "streaming" })
    }
  }

  const textStreamBatcher = createFrameBatcher({
    flush: renderTextStreamFrame,
    frameMs: TUI_FRAME_MS
  })

  const ghostPredictor = createGhostPredictor({
    configState: ctx.configState,
    onGhost(ghost, forInput) {
      // 双保险：predictor 已经比对过，这里再确认一次 UI 侧输入没变
      if (ui.input !== forInput || ui.busy) return
      ui.ghostText = ghost
      requestRender()
    }
  })

  function finalizeTextStream(status = "complete") {
    textStreamBatcher.flushNow()
    if (ui.streamLogId) updateLog(ui.streamLogId, { status })
    ui.streamLogId = null
    ui.streamRaw = ""
  }

  const activityRenderer = createActivityRenderer({
    theme: ctx.themeState.theme,
    output: { appendLog, updateLog, appendStreamChunk },
    eventFilter: (event) =>
      (!event?.sessionId || event.sessionId === state.sessionId) &&
      shouldApplyActiveTurnEvent(event, {
        sessionId: state.sessionId,
        turnId: ui.activeTurnId
      })
  })

  const transcriptUnsub = transcript.subscribe(() => {
    if (ui.scrollOffset === 0) ui.scrollOffset = 0
    requestRender()
  })
  // toast 过期要自己触发重绘。此前 store 的 subscribe 无人订阅 —— 空闲时
  // 一条提示会一直挂在屏幕上，直到用户碰下一个键才消失（忙碌时 spinner
  // 的定时重绘恰好掩盖了这一点，所以从没被注意到）。
  const toastUnsub = toastStore.subscribe(() => requestRender())

  const uiEventUnsub = EventBus.subscribe((event) => {
    const { type, payload } = event
    if (!shouldApplyActiveTurnEvent(event, {
      sessionId: state.sessionId,
      turnId: ui.activeTurnId
    })) {
      return
    }
    ui.appState = reduceAppState(ui.appState, event)
    switch (type) {
      case EVENT_TYPES.TURN_START:
        ui.activeTurnId = event.turnId || null
        break
      case EVENT_TYPES.TURN_STEP_START: {
        finalizeTextStream()
        applyThinkingTransition(startThinkingWait(ui.thinking, { now: Date.now() }))
        ui.currentStep = payload.step || 0
        ui.maxSteps = Number(ctx.configState.config.agent?.max_steps) || 25
        ui.currentActivity = { type: "thinking" }
        requestRender()
        break
      }
      case EVENT_TYPES.TOOL_START:
        finalizeTextStream()
        finalizeThinking()
        ui.currentActivity = { type: "tool", tool: payload.tool, args: payload.args }
        requestRender()
        break
      case EVENT_TYPES.TOOL_FINISH:
      case EVENT_TYPES.TOOL_ERROR:
        ui.currentActivity = { type: "thinking" }
        requestRender()
        break
      case EVENT_TYPES.STREAM_TEXT_START:
        finalizeTextStream()
        finalizeThinking()
        ui.streamRaw = ""
        ui.streamLogId = appendLog("", { kind: "assistant", status: "streaming" })
        ui.currentActivity = { type: "writing" }
        requestRender()
        break
      case EVENT_TYPES.STREAM_TEXT_DELTA: {
        ui.streamRaw += String(payload.text || payload.content || "")
        textStreamBatcher.schedule()
        break
      }
      case EVENT_TYPES.STREAM_THINKING_START:
        finalizeTextStream()
        applyThinkingTransition(startThinkingStream(ui.thinking, { now: Date.now() }))
        ui.currentActivity = { type: "thinking" }
        requestRender()
        break
      case EVENT_TYPES.STREAM_THINKING_DELTA: {
        const transition = appendThinkingDelta(
          ui.thinking,
          payload.text || payload.content || "",
          { now: Date.now() }
        )
        ui.thinking = transition.state
        requestRender()
        break
      }
      case EVENT_TYPES.SESSION_COMPACTED: {
        // D3：静默压缩 + toast。压缩本身不打断工作流，这里只报一句结果。
        const before = Number(event.payload?.beforeTokens) || 0
        const after = Number(event.payload?.afterTokens) || 0
        const detail = before > 0 && after > 0
          ? `${formatTokenCount(before)} → ${formatTokenCount(after)}`
          : `${event.payload?.summarizedCount ?? "?"} messages summarized`
        showToast(`Context compacted · ${detail}`, { topic: "compaction", tone: "success" })
        break
      }
      case EVENT_TYPES.TURN_USAGE_UPDATE: {
        const u = payload.usage || {}
        ui.metrics.tokenMeter = {
          ...ui.metrics.tokenMeter,
          estimated: true,
          turn: { input: u.input || 0, output: u.output || 0 }
        }
        // Provider/model pricing is resolved after the turn. Never present a
        // hard-coded model rate as a live cost estimate.
        ui.metrics.cost = null
        if (payload.context) ui.metrics.context = payload.context
        requestRender()
        break
      }
      case EVENT_TYPES.PROVIDER_RETRY:
        showToast(
          `Reconnecting ${payload.retryAttempt}/${payload.maxRetries} · ${payload.classification}`,
          {
            topic: "provider-retry",
            tone: "warning",
            durationMs: Math.max(1200, Number(payload.delayMs || 0) + 500)
          }
        )
        ui.currentActivity = { type: "thinking" }
        requestRender()
        break
      case EVENT_TYPES.TURN_FINISH:
        finalizeThinking()
        finalizeTextStream()
        toastStore.dismissTopic("provider-retry")
        ui.currentActivity = null
        ui.currentStep = 0
        ui.activeTurnId = null
        requestRender()
        break
      case EVENT_TYPES.TURN_ERROR:
        finalizeThinking()
        finalizeTextStream("error")
        toastStore.dismissTopic("provider-retry")
        ui.currentActivity = null
        ui.currentStep = 0
        ui.activeTurnId = null
        requestRender()
        break
    }
  })
  // Subscribe activity logs after typed stream state so a completed Thinking
  // block is inserted before the tool block that follows it.
  activityRenderer.start()

  function queuePermissionPrompt(request) {
    ui.permissionQueue.push(request)
    if (!ui.pendingPermission) {
      ui.pendingPermission = ui.permissionQueue.shift() || null
      ui.permissionSelected = defaultPermissionIndex(ui.pendingPermission)
    }
    requestRender({ force: true })
  }

  function resolvePermissionPrompt(decision) {
    if (!ui.pendingPermission) return
    const current = ui.pendingPermission
    ui.pendingPermission = null
    ui.permissionSelected = 0
    try {
      current.resolve(decision)
    } catch {}
    if (ui.permissionQueue.length) {
      ui.pendingPermission = ui.permissionQueue.shift() || null
      ui.permissionSelected = defaultPermissionIndex(ui.pendingPermission)
    }
    requestRender({ force: true })
  }

  function defaultPermissionIndex(perm) {
    return defaultPermissionChoiceIndex(perm?.defaultAction)
  }

  function queueQuestionPrompt(request) {
    ui.questionQueue.push({
      ...request,
      questions: sanitizeTerminalValue(request?.questions || [])
    })
    if (!ui.pendingQuestion) {
      activateNextQuestion()
    }
    requestRender({ force: true })
  }

  function activateNextQuestion() {
    const next = activateNextQuestionState(ui.questionQueue)
    if (next.queue) ui.questionQueue = next.queue
    ui.pendingQuestion = next.pendingQuestion
    ui.questionIndex = next.questionIndex
    ui.questionOptionSelected = next.questionOptionSelected
    ui.questionMultiSelected = next.questionMultiSelected
    ui.questionCustomMode = next.questionCustomMode
    ui.questionCustomInput = next.questionCustomInput
    ui.questionCustomCursor = next.questionCustomCursor
    ui.questionAnswers = next.questionAnswers
  }

  function commitCurrentQuestionAnswer() {
    const next = commitQuestionAnswer({
      pendingQuestion: ui.pendingQuestion,
      questionIndex: ui.questionIndex,
      questionOptionSelected: ui.questionOptionSelected,
      questionMultiSelected: ui.questionMultiSelected,
      questionCustomMode: ui.questionCustomMode,
      questionCustomInput: ui.questionCustomInput,
      questionAnswers: ui.questionAnswers
    })
    ui.questionAnswers = next.questionAnswers
    ui.questionCustomMode = next.questionCustomMode
    ui.questionCustomInput = next.questionCustomInput
    ui.questionCustomCursor = next.questionCustomCursor
  }

  function advanceOrSubmitQuestion() {
    commitCurrentQuestionAnswer()
    const next = advanceQuestionState({
      pendingQuestion: ui.pendingQuestion,
      questionIndex: ui.questionIndex,
      questionOptionSelected: ui.questionOptionSelected,
      questionCustomMode: ui.questionCustomMode,
      questionCustomInput: ui.questionCustomInput,
      questionCustomCursor: ui.questionCustomCursor
    })
    if (!next.shouldSubmit) {
      ui.questionIndex = next.questionIndex
      ui.questionOptionSelected = next.questionOptionSelected
      ui.questionCustomMode = next.questionCustomMode
      ui.questionCustomInput = next.questionCustomInput
      ui.questionCustomCursor = next.questionCustomCursor
      requestRender({ force: true })
    } else {
      resolveQuestionPrompt()
    }
  }

  function resolveQuestionPrompt() {
    if (!ui.pendingQuestion) return
    const current = ui.pendingQuestion
    const answers = finalizeQuestionAnswers(current, ui.questionAnswers)
    ui.pendingQuestion = null
    ui.questionIndex = 0
    ui.questionOptionSelected = 0
    ui.questionMultiSelected = {}
    ui.questionCustomMode = false
    ui.questionCustomInput = ""
    ui.questionCustomCursor = 0
    ui.questionAnswers = {}
    try {
      current.resolve(answers)
    } catch {}
    activateNextQuestion()
    requestRender({ force: true })
  }

  /**
   * Resolve every application-owned modal before teardown. Permission prompts
   * fail closed; unfinished questions return explicit skipped values. This
   * prevents an awaiting tool turn from surviving after the terminal UI exits.
   */
  function settlePendingPromptsForExit() {
    const permissions = [
      ...(ui.pendingPermission ? [ui.pendingPermission] : []),
      ...ui.permissionQueue
    ]
    ui.pendingPermission = null
    ui.permissionQueue = []
    ui.permissionSelected = 0
    for (const permission of permissions) {
      try { permission.resolve("deny") } catch {}
    }

    const questions = [
      ...(ui.pendingQuestion
        ? [{ request: ui.pendingQuestion, answers: ui.questionAnswers }]
        : []),
      ...ui.questionQueue.map((request) => ({ request, answers: {} }))
    ]
    ui.pendingQuestion = null
    ui.questionQueue = []
    ui.questionIndex = 0
    ui.questionOptionSelected = 0
    ui.questionMultiSelected = {}
    ui.questionCustomMode = false
    ui.questionCustomInput = ""
    ui.questionCustomCursor = 0
    ui.questionAnswers = {}
    for (const { request, answers } of questions) {
      try {
        request.resolve(finalizeQuestionAnswers(request, answers))
      } catch {}
    }
  }

  function abortTurnAndPromptsForExit() {
    if (ui.turnAbortController) {
      ui.turnAbortController.abort()
      ui.turnAbortController = null
    }
    settlePendingPromptsForExit()
  }

  function openProviderPicker(items = []) {
    if (!items.length) {
      showToast("没有已配置的 provider · /provider add 添加", { topic: "provider", tone: "warn" })
      requestRender()
      return
    }
    const currentIdx = items.findIndex((item) => item.name === state.providerType)
    ui.providerPicker = { items, selected: Math.max(0, currentIdx), offset: 0 }
    requestRender({ force: true })
  }

  function closeProviderPicker() {
    ui.providerPicker = null
    requestRender({ force: true })
  }

  async function confirmProviderPicker() {
    if (!ui.providerPicker?.items) return
    const chosen = ui.providerPicker.items[ui.providerPicker.selected]
    ui.providerPicker = null
    if (!chosen) {
      requestRender({ force: true })
      return
    }
    if (chosen.name === state.providerType) {
      showToast(`Provider · ${chosen.name}（已是当前渠道）`, { topic: "provider" })
      requestRender({ force: true })
      return
    }
    // 走用户手敲 `/provider <name>` 的同一条码：切渠道要重取模型目录、
    // 校验凭据、回写状态，那些逻辑只应存在一处。
    ui.input = `/provider ${chosen.name}`
    ui.inputCursor = ui.input.length
    await submitCurrentInput()
  }

  function openSessionPicker(items = []) {
    if (!items.length) {
      showToast("没有可续跑的会话", { topic: "session", tone: "warn" })
      requestRender()
      return
    }
    ui.sessionPicker = { items, selected: 0, offset: 0 }
    requestRender({ force: true })
  }

  function closeSessionPicker() {
    ui.sessionPicker = null
    requestRender({ force: true })
  }

  async function confirmSessionPicker() {
    if (!ui.sessionPicker?.items) return
    const chosen = ui.sessionPicker.items[ui.sessionPicker.selected]
    ui.sessionPicker = null
    if (!chosen) {
      requestRender({ force: true })
      return
    }
    // 走 `/resume <id>` 的同一条码：续跑要恢复渠道、模型、历史，那些逻辑只应有一处
    ui.input = `/resume ${chosen.id}`
    ui.inputCursor = ui.input.length
    await submitCurrentInput()
  }

  function openModelPicker(items = []) {
    if (!items.length) {
      showToast("No models discovered · use /model <model-id>", {
        topic: "model",
        tone: "error",
        durationMs: 5000
      })
      requestRender()
      return
    }
    const currentIdx = items.findIndex((it) => it.model === state.model && it.provider === state.providerType)
    ui.modelPicker = {
      items,
      selected: Math.max(0, currentIdx),
      offset: 0
    }
    requestRender({ force: true })
  }

  function closeModelPicker() {
    ui.modelPicker = null
    requestRender({ force: true })
  }

  function confirmModelPicker() {
    if (!ui.modelPicker) return
    const chosen = ui.modelPicker.items[ui.modelPicker.selected]
    if (chosen) {
      state.providerType = chosen.provider
      state.model = chosen.model
      showToast(`Model · ${chosen.provider} / ${chosen.model}`, {
        topic: "model",
        tone: "success"
      })
    }
    closeModelPicker()
  }

  /**
   * 打开只读信息浮层。
   *
   * 与 `printTui(text, { channel: "panel" })` 的区别是它**不进对话记录**：
   * `/status`、`/permission` 这类查询当前状态的输出是给人看的，进了对话记录
   * 就会随会话一起发给模型，还会被 /clear 连带清掉，看完也关不掉。
   */
  function openInfoPanel(title, text, { maxRows = 14 } = {}) {
    // text 可以是函数：内容自己画框时需要知道浮层内宽，否则外层折行会把它的
    // 边框折断。内宽 = 终端宽 - 左右边框与内边距（各 2 格）。
    const innerWidth = Math.max(20, (Number(process.stdout.columns) || 120) - 4)
    const resolved = typeof text === "function" ? text(innerWidth) : text
    ui.infoPanel = {
      title,
      lines: String(resolved ?? "").split("\n"),
      offset: 0,
      maxOffset: 0,
      maxRows,
      // 记下排版时的宽度：终端 resize 后据此重算，而不是让内容错位
      renderedAt: innerWidth,
      source: typeof text === "function" ? text : null
    }
    requestRender({ force: true })
  }

  function closeInfoPanel() {
    if (!ui.infoPanel) return false
    ui.infoPanel = null
    requestRender({ force: true })
    return true
  }

  function scrollInfoPanel(delta) {
    if (!ui.infoPanel) return
    const max = Number(ui.infoPanel.maxOffset) || 0
    ui.infoPanel.offset = Math.max(0, Math.min(max, (ui.infoPanel.offset || 0) + delta))
    requestRender()
  }

  function openModePicker() {
    ui.modePicker = createModePickerState(state.modeId || resolveModeId(state.mode))
    requestRender({ force: true })
  }

  function closeModePicker() {
    ui.modePicker = null
    requestRender({ force: true })
  }

  function confirmModePicker() {
    if (!ui.modePicker) return
    const chosen = MODE_PICKER_CHOICES[ui.modePicker.selected]
    closeModePicker()
    if (chosen) selectModeAndNotify(chosen.value)
  }

  function openPolicyPicker() {
    const current = ctx.configState.config.permission || {}
    ui.policyPicker = createPolicyPickerState(current)
    requestRender({ force: true })
  }

  function closePolicyPicker() {
    ui.policyPicker = null
    requestRender({ force: true })
  }

  function confirmPolicyPicker() {
    if (!ui.policyPicker) return
    const chosen = POLICY_CHOICES[ui.policyPicker.selected]
    if (chosen) {
      const permission = ctx.configState.config.permission || (ctx.configState.config.permission = {})
      const result = applyPolicyChoice(chosen, {
        permissionConfig: permission,
        sessionId: state.sessionId,
        clearSession: (sessionId) => PermissionEngine.clearSession(sessionId)
      })
      ctx.configState.config.permission = result.permissionConfig
      if (result.message) {
        showToast(stripAnsi(result.message), { topic: "permission", tone: "success" })
      }
    }
    closePolicyPicker()
  }

  function setInputFromHistory(value) {
    ui.input = value || ""
    ui.inputCursor = ui.input.length
    onInputChanged()
  }

  function insertAtCursor(text) {
    if (!text) return
    const head = ui.input.slice(0, ui.inputCursor)
    const tail = ui.input.slice(ui.inputCursor)
    ui.input = `${head}${text}${tail}`
    ui.inputCursor += text.length
    onInputChanged()
  }

  /**
   * 任何改动输入内容的路径都必须经过这里：作废当前 ghost 并重新排期预测。
   * 陈旧的 ghost 比没有 ghost 更糟——它会让用户以为按 Tab 补的是别的内容。
   */
  function onInputChanged() {
    if (ui.ghostText) {
      ui.ghostText = ""
      requestRender()
    }
    ghostPredictor?.schedule(ui.input, {
      busy: ui.busy,
      modal: Boolean(ui.pendingPermission || ui.pendingQuestion || ui.modelPicker || ui.policyPicker || ui.modePicker)
    })
  }

  function acceptGhost() {
    if (!ui.ghostText) return false
    const ghost = ui.ghostText
    ui.ghostText = ""
    ui.input += ghost
    ui.inputCursor = ui.input.length
    ghostPredictor?.cancel()
    requestRender()
    return true
  }

  function moveCursor(delta) {
    ui.inputCursor = moveGraphemeCursor(ui.input, ui.inputCursor, delta)
  }

  function setCursor(pos) {
    ui.inputCursor = Math.max(0, Math.min(ui.input.length, pos))
  }

  function scrollBy(delta) {
    const max = ui.scrollMeta.maxOffset || 0
    ui.scrollOffset = Math.max(0, Math.min(max, ui.scrollOffset + delta))
  }

  function scrollToTop() {
    ui.scrollOffset = ui.scrollMeta.maxOffset || 0
  }

  function scrollToBottom() {
    ui.scrollOffset = 0
  }

  // Request OSC 52 and try a platform clipboard command. OSC 52 itself cannot
  // confirm whether the terminal accepted the request, so only a successful
  // native fallback may use definitive "Copied" wording.
  async function copyToClipboard(text) {
    clipboardAbortController?.abort()
    const controller = new AbortController()
    clipboardAbortController = controller
    const result = await copyTerminalText(text, {
      output,
      signal: controller.signal
    })
    if (clipboardAbortController === controller) {
      clipboardAbortController = null
    }
    if (disposed || controller.signal.aborted) return result
    if (result.confirmed) {
      showToast("Copied selection", { topic: "clipboard", tone: "success" })
    } else if (result.requested) {
      showToast("Copy requested · terminal approval may be required", {
        topic: "clipboard",
        tone: "info",
        durationMs: 4200
      })
    } else {
      showToast("Copy failed · use the terminal copy shortcut", {
        topic: "clipboard",
        tone: "error",
        durationMs: 5000
      })
    }
    return result
  }

  // 从渲染后的屏幕行中提取纯文本（用于选择复制）
  // 对屏幕行数组应用选择高亮（反色）。选区存的是 transcript 绝对行，
  // 这里换算回当前视口的屏幕行；滚出视口的部分自然不绘制。
  function applySelectionHighlight(frameLines, sel) {
    if (!sel) return
    const {
      startRow: a1,
      startCol: c1,
      endRow: a2,
      endCol: c2,
      isClick
    } = normalizeMouseSelection({
      startRow: (sel.startAbs ?? 0) + 1,
      startCol: sel.startCol,
      endRow: (sel.endAbs ?? 0) + 1,
      endCol: sel.endCol,
      moved: sel.moved
    })
    if (isClick) return

    for (let abs = a1; abs <= a2; abs++) {
      const r = screenRowFromAbsolute(abs, ui.layoutMeta)
      if (r === null || r < 0 || r >= frameLines.length) continue
      const plain = stripAnsi(frameLines[r])
      const sc = abs === a1 ? c1 : 0
      const ec = abs === a2 ? c2 : displayWidth(plain)
      if (sc >= ec || sc >= displayWidth(plain)) continue

      const { before, selected, after } = splitTextByCellRange(plain, sc, ec)
      // \x1b[7m = 反色开始, \x1b[27m = 反色结束
      frameLines[r] = before + "\x1b[7m" + selected + "\x1b[27m" + after
    }
  }

  function buildFrame() {
    // 宽高在这里读一次并传下去 —— frame-builder 不碰 process.stdout，
    // 所以任意宽度都能在测试里断言（见 test/frame-builder.test.mjs）。
    return buildFrameLines({
      ui,
      ctx,
      state,
      transcript,
      width: Number(process.stdout.columns || 120),
      height: Number(process.stdout.rows || 40),
      slashOptions: slashRouterOptions(localCustomCommands),
      applySelectionHighlight,
      renderToastLine
    })
  }

  function paintFrame(frame) {
    if (disposed || terminalSuspended) return
    if (!frame || !Array.isArray(frame.lines)) return
    _lastFrame = frame  // 保存帧数据供鼠标选择使用
    const fullPaint = forceFullPaint || frame.width !== lastFrameWidth || lastFrame.length !== frame.lines.length
    output.write(renderTerminalFrame({
      lines: frame.lines,
      previousLines: lastFrame,
      width: frame.width,
      height: frame.height,
      cursor: frame.cursor,
      force: fullPaint
    }))
    lastFrame = frame.lines
    lastFrameWidth = frame.width
    forceFullPaint = false
  }

  function requestRender({ force = false } = {}) {
    if (disposed || terminalSuspended) return
    if (force) forceFullPaint = true
    if (renderScheduled) return
    renderScheduled = true
    renderTimer = setTimeout(() => {
      renderScheduled = false
      renderTimer = null
      paintFrame(buildFrame())
    }, TUI_FRAME_MS)
  }

  function startBusySpinner() {
    if (spinnerTimer) return
    spinnerTimer = setInterval(() => {
      ui.spinnerIndex = (ui.spinnerIndex + 1) % BUSY_SPINNER_FRAMES.length
      requestRender()
    }, 120)
  }

  function stopBusySpinner() {
    if (!spinnerTimer) return
    clearInterval(spinnerTimer)
    spinnerTimer = null
  }

  let pendingPlanBuild = null

  async function submitCurrentInput() {
    const line = ui.input.replace(/\r/g, "")
    if (!line.trim() || ui.busy) return
    // 提交即作废预测：在途请求的结果对下一轮输入毫无意义
    ui.ghostText = ""
    ghostPredictor.cancel()
    ensureEventSinks()

    // --- Task 3: 处理中途补充需求确认 ---
    if (ui.pendingModeConfirm && !isCommandLikeInput(line)) {
      const confirm = ui.pendingModeConfirm
      ui.pendingModeConfirm = null
      const answer = line.trim().toLowerCase()
      const confirmed = ["y", "yes", "是", "继续", "ok", "好"].includes(answer)
      if (confirmed) {
        // 用户确认继续用 longagent，清除 abort 状态
        ui.longagentAborted = false
        showToast("继续使用 LongAgent", { topic: "mode", tone: "success" })
        ui.input = ""
        ui.inputCursor = 0
        requestRender()
        return
      } else {
        // 用户拒绝，切换到建议模式
        state.mode = confirm.suggestedMode
        showToast(`Mode · ${confirm.suggestedMode}`, { topic: "mode", tone: "success" })
        ui.input = ""
        ui.inputCursor = 0
        requestRender()
        return
      }
    }

    if (ui.agentAborted && state.mode === "agent" && !isCommandLikeInput(line)) {
      const summary = ui.agentTransaction
      ui.agentAborted = false
      if (summary && line.trim()) {
        submittedLine = buildAgentContinuationPrompt(summary, line.trim())
        route = routeMode(submittedLine, state.mode, { continuation: summary, continued: true })
        await EventBus.emit({
          type: EVENT_TYPES.ROUTE_DECISION,
          sessionId: state.sessionId,
          payload: {
            ...(route.observability || {}),
            promptLength: submittedLine.length,
            continuedTransaction: true
          }
        })
        await EventBus.emit({
          type: EVENT_TYPES.AGENT_CONTINUATION_RESUMED,
          sessionId: state.sessionId,
          payload: {
            topology: route.topology,
            evidence: route.evidence,
            continuationCount: Number(summary.continuationCount || 0) + 1
          }
        })
        ui.agentTransaction = summarizeAgentTransaction({
          prompt: summary.objective || line,
          route,
          previous: {
            ...summary,
            continuationCount: Number(summary.continuationCount || 0) + 1
          }
        })
        appendLog(paint(`↻ 继续当前 agent 事务（${route.explanation || route.reason}）`, ctx.themeState.theme.semantic.info))
      }
    }

    // --- Task 3: 处理 longagent 中途补充需求 ---
    if (ui.longagentAborted && state.mode === "longagent" && !isCommandLikeInput(line)) {
      const originalPrompt = ui.lastLongAgentPrompt
      ui.longagentAborted = false
      ui.lastLongAgentPrompt = null
      if (originalPrompt && line.trim()) {
        // 合并原始需求 + 补充需求，从 H0 重新规划
        const mergedPrompt = `${originalPrompt}\n\n[补充需求]\n${line.trim()}`
        appendLog(paint("已合并补充需求，从头重新规划...", ctx.themeState.theme.semantic.info))
        ui.history.push(line)
        if (ui.history.length > HIST_SIZE) ui.history.splice(0, ui.history.length - HIST_SIZE)
        ui.historyIndex = ui.history.length
        appendLog(paint("❯ ", ctx.themeState.theme.semantic.success) + paint(line, ctx.themeState.theme.roles?.user), { kind: "user" })
        appendLog("")
        ui.input = ""
        ui.inputCursor = 0
        ui.selectedSuggestion = 0
        ui.suggestionOffset = 0
        ui.busy = true
        ui.paused = false
        const aborter = new AbortController()
        ui.turnAbortController = aborter
        ui.lastLongAgentPrompt = mergedPrompt
        startBusySpinner()
        requestRender()
        try {
          const action = (await processInputLine({
            line: mergedPrompt,
            state, ctx, providersConfigured,
            customCommands: localCustomCommands,
            setCustomCommands: (next) => { localCustomCommands = next },
            wizard: ui.wizard,
            setWizard: (next) => { ui.wizard = next },
            providerPicker: ui.providerPicker,
            setProviderPicker: (next) => { ui.providerPicker = next },
            print: printTui,
            streamSink: appendStreamChunk,
            showTurnStatus: false,
            pendingImages: ui.pendingImages,
            clearPendingImages: () => { ui.pendingImages = [] },
            signal: aborter.signal,
            suspendTui: withSuspendedTui,
            openPanel: openInfoPanel
          })) || {}
          if (action.turnResult) {
            ui.metrics.tokenMeter = action.turnResult.tokenMeter || ui.metrics.tokenMeter
            ui.metrics.cost = Number.isFinite(action.turnResult.cost) ? action.turnResult.cost : ui.metrics.cost
            ui.metrics.costSavings = action.turnResult.costSavings ?? 0
            if (action.turnResult.context) ui.metrics.context = action.turnResult.context
            ui.metrics.longagent = action.turnResult.longagent || null
            ui.metrics.toolEvents = action.turnResult.toolEvents || []
          }
          if (action.exit) ui.quitting = true
        } catch (error) {
          if (error.name !== "AbortError") appendLog(`error: ${sanitizeTerminalText(error.message)}`)
        } finally {
          finalizeThinking()
          finalizeTextStream()
          if (aborter.signal.aborted && state.mode === "longagent") {
            ui.longagentAborted = true
            ui.lastLongAgentPrompt = mergedPrompt
            appendLog(paint("⏸ LongAgent 已中止。输入补充需求后按 Enter 可从头重新规划，或切换模式继续。", ctx.themeState.theme.semantic.warn))
          }
          ui.busy = false
          ui.turnAbortController = null
          ui.currentActivity = null
          stopBusySpinner()
          requestRender()
        }
        return
      }
    }

    let submittedLine = line
    let activeAgentContinuation = null
    let routeRequestedMode = state.mode

    if (ui.paused && ui.agentContinuation && state.mode === "agent" && !isCommandLikeInput(line)) {
      activeAgentContinuation = ui.agentContinuation
      submittedLine = buildAgentContinuationPrompt(activeAgentContinuation, line)
      ui.agentContinuation = null
      ui.paused = false
      appendLog(paint("↻ 继续当前 agent 事务…", ctx.themeState.theme.semantic.info))
      if (activeAgentContinuation.pendingNextStep) {
        appendLog(paint(`   ${activeAgentContinuation.pendingNextStep}`, ctx.themeState.theme.base.muted, { dim: true }))
      }
      await emitAgentContinuationResumed({
        sessionId: state.sessionId,
        summary: activeAgentContinuation,
        continuation: line
      })
    }

    ui.history.push(line)
    if (ui.history.length > HIST_SIZE) ui.history.splice(0, ui.history.length - HIST_SIZE)
    ui.historyIndex = ui.history.length

    appendLog(paint("❯ ", ctx.themeState.theme.semantic.success) + paint(line, ctx.themeState.theme.roles?.user), { kind: "user" })
    appendLog("")
    ui.input = ""
    ui.inputCursor = 0
    ui.selectedSuggestion = 0
    ui.suggestionOffset = 0
    ui.busy = true
    ui.paused = false
    const aborter = new AbortController()
    ui.turnAbortController = aborter

    // --- Task 1: 自动路由 ---
    let route = null
    if (!isCommandLikeInput(line)) {
      routeRequestedMode = state.mode
      route = routeMode(submittedLine, state.mode)
      const routeFeedback = buildRouteFeedback({
        route,
        currentMode: state.mode,
        routeSummary: summarizeRouteDecision(route)
      })
      await emitRouteDecisionEvent({
        sessionId: state.sessionId,
        source: "repl",
        requestedMode: routeRequestedMode,
        route,
        prompt: submittedLine,
        continuedTransaction: Boolean(activeAgentContinuation)
      })
      if (routeFeedback.changedMessage) {
        showToast(stripAnsi(routeFeedback.changedMessage), { topic: "route", tone: "info" })
        state.mode = route.mode
      } else if (routeFeedback.forcedMessage) {
        // 用户强制 longagent 但任务看起来是简单任务 → 需要确认
        ui.pendingModeConfirm = { suggestedMode: route.suggestion, originalMode: state.mode, reason: route.reason }
        appendLog(paint(routeFeedback.forcedMessage, ctx.themeState.theme.semantic.warn))
        ui.busy = false
        ui.turnAbortController = null
        stopBusySpinner()
        requestRender()
        return
      } else if (routeFeedback.suggestionMessage) {
        showToast(stripAnsi(routeFeedback.suggestionMessage), { topic: "route", tone: "info" })
      } else if (routeFeedback.stayedMessage) {
        showToast(stripAnsi(routeFeedback.stayedMessage), { topic: "route", tone: "info" })
      }
      if (routeFeedback.summaryMessage) {
        showToast(stripAnsi(routeFeedback.summaryMessage), { topic: "route-summary", tone: "info" })
      }

      if (state.mode === "agent") {
        ui.agentContinuation = summarizeAgentTransaction({
          prompt: submittedLine,
          route,
          mode: state.mode
        })
      } else {
        ui.agentContinuation = null
      }
    }

    // 记录 longagent 原始 prompt（用于 Task 3 中途补充需求）
    if (state.mode === "longagent" && !isCommandLikeInput(line)) {
      ui.lastLongAgentPrompt = submittedLine
      ui.longagentAborted = false
      ui.agentTransaction = null
      ui.agentAborted = false
    } else if (state.mode === "agent" && !isCommandLikeInput(line)) {
      ui.agentTransaction = summarizeAgentTransaction({
        prompt: ui.agentTransaction?.objective || line,
        route,
        previous: ui.agentTransaction
      })
      ui.agentAborted = false
    } else if (!isCommandLikeInput(line)) {
      ui.agentTransaction = null
      ui.agentAborted = false
    }

    startBusySpinner()
    requestRender()

    try {
      const action = (await processInputLine({
        line: submittedLine,
        state,
        ctx,
        providersConfigured,
        customCommands: localCustomCommands,
        setCustomCommands: (next) => {
          localCustomCommands = next
        },
        wizard: ui.wizard,
        setWizard: (next) => { ui.wizard = next },
        providerPicker: ui.providerPicker,
        setProviderPicker: (next) => { ui.providerPicker = next },
        print: printTui,
        streamSink: appendStreamChunk,
        showTurnStatus: false,
        pendingImages: ui.pendingImages,
        clearPendingImages: () => { ui.pendingImages = [] },
        signal: aborter.signal,
        suspendTui: withSuspendedTui,
        openPanel: openInfoPanel
      })) || {}

      if (action.cleared) {
        transcript.clear()
      }
      if (action.dashboardRefresh) {
        localRecentSessions = action.recentSessions || localRecentSessions
        ui.showDashboard = true
        showToast("Dashboard refreshed", { topic: "dashboard", tone: "success" })
      }
      if (action.turnResult) {
        ui.metrics.tokenMeter = action.turnResult.tokenMeter || ui.metrics.tokenMeter
        ui.metrics.cost = Number.isFinite(action.turnResult.cost) ? action.turnResult.cost : ui.metrics.cost
        ui.metrics.costSavings = action.turnResult.costSavings ?? 0
        if (action.turnResult.context) ui.metrics.context = action.turnResult.context
        ui.metrics.longagent = action.turnResult.longagent || null
        ui.metrics.toolEvents = action.turnResult.toolEvents || []
        if (state.mode === "agent" && ui.agentTransaction) {
          ui.agentTransaction = summarizeAgentTransaction({
            prompt: ui.agentTransaction.objective || line,
            route,
            previous: ui.agentTransaction,
            toolEvents: action.turnResult.toolEvents || [],
            reply: action.turnResult.reply || ""
          })
        }
      }
      // logo 显示由 Ctrl+B 手动切换，不再自动隐藏
      if (action.openModelPicker) {
        openModelPicker(action.modelPickerItems)
      }
      if (action.openProviderPicker) {
        openProviderPicker(action.providerPickerItems)
      }
      if (action.openSessionPicker) {
        openSessionPicker(action.sessionPickerItems)
      }
      if (action.openPolicyPicker) {
        openPolicyPicker()
      }
      if (action.openModePicker) {
        openModePicker()
      }
      if (action.planHandoff?.modeId) {
        // switchModeInPlace 已经改过 state；这里只同步 UI 并排队续跑
        pendingPlanBuild = action.planHandoff
        showToast(`${action.planHandoff.icon} ${action.planHandoff.label} · 开始执行计划`, {
          topic: "mode",
          tone: "success"
        })
      }
      if (action.exit) {
        ui.quitting = true
      }
    } catch (error) {
      if (error.name !== "AbortError") appendLog(`error: ${sanitizeTerminalText(error.message)}`)
    } finally {
      finalizeThinking()
      finalizeTextStream()
      // Task 3: 检测 longagent 被中止，提示用户可补充需求
      if (aborter.signal.aborted && state.mode === "longagent" && ui.lastLongAgentPrompt) {
        ui.longagentAborted = true
        appendLog(paint("⏸ LongAgent 已中止。输入补充需求后按 Enter 可从头重新规划，或切换模式继续。", ctx.themeState.theme.semantic.warn))
      } else if (aborter.signal.aborted && state.mode === "agent" && ui.agentContinuation) {
        await emitAgentContinuationInterrupted({
          sessionId: state.sessionId,
          summary: ui.agentContinuation
        })
        appendLog(paint("⏸ Agent 已中止。直接输入补充内容即可继续当前本地事务，或输入命令切换模式。", ctx.themeState.theme.semantic.warn))
      }
      ui.busy = false
      ui.turnAbortController = null
      ui.currentActivity = null
      stopBusySpinner()
      requestRender()
    }

    // Plan → Build 交接：模式已切好，直接以计划文件为输入续跑一轮。
    // pendingPlanBuild 先清空，递归深度因此固定为 1。
    if (pendingPlanBuild && !ui.quitting && !aborter.signal.aborted) {
      const handoff = pendingPlanBuild
      pendingPlanBuild = null
      const planRef = handoff.planPath ? ` at ${handoff.planPath}` : ""
      ui.input = `Implement the approved plan${planRef}. Follow it stage by stage and report what you changed.`
      ui.inputCursor = ui.input.length
      await submitCurrentInput()
    }
  }

  function handleUpDownSuggestions(keyName) {
    const suggestions = slashSuggestions(ui.input, slashRouterOptions(localCustomCommands))
    if (suggestions.length > 0 && isCommandLikeInput(ui.input)) {
      if (keyName === "up") {
        ui.selectedSuggestion = Math.max(0, ui.selectedSuggestion - 1)
      } else {
        ui.selectedSuggestion = Math.min(suggestions.length - 1, ui.selectedSuggestion + 1)
      }
      return true
    }
    return false
  }

  function navigateHistory(keyName) {
    const result = resolveHistoryNavigation(ui.history, ui.historyIndex, keyName)
    if (!result.changed) return
    ui.historyIndex = result.historyIndex
    setInputFromHistory(result.value)
  }

  function applyCurrentSuggestion() {
    const suggestions = slashSuggestions(ui.input, slashRouterOptions(localCustomCommands))
    if (!suggestions.length) return
    const chosen = suggestions[Math.max(0, Math.min(ui.selectedSuggestion, suggestions.length - 1))]
    ui.input = applySuggestionToInput(ui.input, chosen.name)
    ui.inputCursor = ui.input.length
    onInputChanged()
  }

  function shouldApplySuggestionOnEnter() {
    return shouldApplySlashSuggestionOnEnter(
      ui.input,
      slashSuggestions(ui.input, slashRouterOptions(localCustomCommands)),
      ui.selectedSuggestion
    )
  }

  /**
   * 切换模式同时写两处：state.modeId（唯一真值）与 permission.level
   * （判定链读的审批档）。state.mode 保持航道值给既有消费者。
   */
  function selectModeAndNotify(modeId, { silent = false } = {}) {
    const permission = ctx.configState.config.permission || (ctx.configState.config.permission = {})
    const next = applyModeSelection(modeId, { permissionConfig: permission })
    state.modeId = next.modeId
    state.mode = next.mode
    ctx.configState.config.permission = next.permissionConfig
    if (!silent) {
      showToast(`${next.icon} ${next.label} · ${next.hint}`, { topic: "mode", tone: "success" })
    }
    requestRender()
    return next
  }

  function cycleModeForwardAndNotify() {
    selectModeAndNotify(nextModeId(state.modeId || resolveModeId(state.mode)))
  }

  function questionAcceptsTextInput() {
    if (!ui.pendingQuestion) return false
    const questions = ui.pendingQuestion.questions || []
    const current = questions[ui.questionIndex] || {}
    const options = Array.isArray(current.options) ? current.options : []
    return ui.questionCustomMode || options.length === 0
  }

  function insertQuestionText(value) {
    if (!questionAcceptsTextInput()) return false
    const text = String(value || "").replace(/\r\n?/g, "\n")
    if (!text) return false
    const cursor = Math.max(0, Math.min(
      ui.questionCustomInput.length,
      ui.questionCustomCursor
    ))
    ui.questionCustomInput =
      ui.questionCustomInput.slice(0, cursor) +
      text +
      ui.questionCustomInput.slice(cursor)
    ui.questionCustomCursor = cursor + text.length
    return true
  }

  // Monkey-patch stdin.emit 拦截鼠标事件，防止 readline 将其解析为键盘输入
  let _lastFrame = null  // 保存最近一帧用于文本提取
  const _origStdinEmit = process.stdin.emit
  const mouseDecoder = createSgrMouseDecoder()
  const pasteDecoder = createBracketedPasteDecoder()
  const plainTextDecoder = createUtf8TextDecoder()

  function dispatchPasteResult(pasted, mouseEventCount = 0, {
    immediateEscape = false
  } = {}) {
    for (const value of pasted.pastes) {
      if (questionAcceptsTextInput()) {
        insertQuestionText(value)
      } else if (!ui.busy) {
        insertAtCursor(String(value || "").replace(/\r\n?/g, "\n"))
      }
    }
    if (mouseEventCount > 0 || pasted.pastes.length > 0) requestRender()
    if (!pasted.text) return false
    if (immediateEscape && pasted.text === "\x1b") {
      return _origStdinEmit.call(process.stdin, "keypress", "\x1b", {
        sequence: "\x1b",
        name: "escape",
        ctrl: false,
        meta: false,
        shift: false
      })
    }
    return _origStdinEmit.call(
      process.stdin,
      "data",
      Buffer.from(pasted.text, "utf8")
    )
  }

  function dispatchDecodedInput(mouse, options = {}) {
    for (const ev of mouse.events) handleMouseEvent(ev)
    const pasted = terminalFeatures.bracketedPaste
      ? pasteDecoder.feed(mouse.text)
      : { text: mouse.text, pastes: [] }
    return dispatchPasteResult(pasted, mouse.events.length, options)
  }

  function cancelProtocolFlush() {
    if (protocolFlushTimer) clearTimeout(protocolFlushTimer)
    protocolFlushTimer = null
  }

  function scheduleProtocolFlush() {
    if (
      !mouseDecoder.hasPending() &&
      !(terminalFeatures.bracketedPaste && pasteDecoder.hasPending())
    ) return
    cancelProtocolFlush()
    protocolFlushTimer = setTimeout(() => {
      protocolFlushTimer = null
      if (disposed || terminalSuspended) return
      const mouseText = terminalFeatures.mouse
        ? mouseDecoder.flush()
        : plainTextDecoder.flush()
      dispatchDecodedInput(
        { events: [], text: mouseText },
        { immediateEscape: true }
      )
      if (terminalFeatures.bracketedPaste && pasteDecoder.hasPending()) {
        dispatchPasteResult(
          pasteDecoder.flush(),
          0,
          { immediateEscape: true }
        )
      }
    }, ESCAPE_SEQUENCE_TIMEOUT_MS)
    protocolFlushTimer.unref?.()
  }

  const interceptStdinEmit = function (event, ...args) {
    if (event === "data") {
      cancelProtocolFlush()
      const raw = args[0]
      const mouse = terminalFeatures.mouse
        ? mouseDecoder.feed(raw)
        : { events: [], text: plainTextDecoder.feed(raw) }
      const emitted = dispatchDecodedInput(mouse)
      scheduleProtocolFlush()
      return emitted
    }
    return _origStdinEmit.call(process.stdin, event, ...args)
  }

  /**
   * 屏幕行 → transcript 绝对行。选区锚点必须存绝对行，否则边选边滚时
   * 屏幕行下的内容会变，松手取到的就是另一段文字。
   */
  function absoluteRowFromScreen(row, layout) {
    const viewportRow = Math.max(0, row - layout.logStartRow)
    return (layout.visibleStartIndex || 0) + viewportRow
  }

  /** transcript 绝对行 → 屏幕行；不在当前视口内时返回 null。 */
  function screenRowFromAbsolute(absRow, layout) {
    const viewportRow = absRow - (layout.visibleStartIndex || 0)
    if (viewportRow < 0) return null
    const row = layout.logStartRow + viewportRow
    return row > layout.logEndRow ? null : row
  }

  function updateDragSelection(row, col, layout) {
    const sel = ui.mouseSelection
    if (!sel?.active) return
    // 拖到日志区外时把行钳制回边界，配合自动滚动继续扩展选区
    const clampedRow = Math.min(Math.max(row, layout.logStartRow), layout.logEndRow)
    sel.endRow = clampedRow
    sel.endCol = col
    sel.endAbs = absoluteRowFromScreen(clampedRow, layout)
    if (sel.endAbs !== sel.startAbs || col !== sel.startCol) sel.moved = true
    requestRender()
  }

  /**
   * 边缘自动滚动。SGR 1002 只在跨 cell 移动时上报，鼠标停在边缘不动是
   * 收不到任何事件的，所以必须由定时器驱动，并在松手/清选区/挂起/退出
   * 四处全部停掉。
   */
  function stopAutoScroll() {
    if (autoScrollTimer) {
      clearInterval(autoScrollTimer)
      autoScrollTimer = null
    }
    autoScrollState = null
  }

  function autoScrollStep(overshoot) {
    const distance = Math.abs(overshoot)
    if (distance >= 6) return { lines: 4, intervalMs: 60 }
    if (distance >= 3) return { lines: 2, intervalMs: 80 }
    return { lines: 1, intervalMs: 120 }
  }

  function updateAutoScroll(row, col, layout) {
    if (!ui.mouseSelection?.active) {
      stopAutoScroll()
      return
    }
    const above = layout.logStartRow - row
    const below = row - layout.logEndRow
    const overshoot = above > 0 ? above : below > 0 ? -below : 0
    if (!overshoot) {
      stopAutoScroll()
      return
    }

    const { lines, intervalMs } = autoScrollStep(overshoot)
    const direction = overshoot > 0 ? lines : -lines
    if (autoScrollState?.intervalMs === intervalMs && autoScrollState?.direction === direction) {
      autoScrollState.col = col
      return
    }

    stopAutoScroll()
    autoScrollState = { direction, intervalMs, col }
    autoScrollTimer = setInterval(() => {
      if (disposed || !ui.mouseSelection?.active) {
        stopAutoScroll()
        return
      }
      const before = ui.scrollOffset
      scrollBy(autoScrollState.direction)
      if (ui.scrollOffset === before) {
        // 已经到顶或到底，继续滚没有意义
        stopAutoScroll()
        return
      }
      const edgeRow = autoScrollState.direction > 0
        ? ui.layoutMeta.logStartRow
        : ui.layoutMeta.logEndRow
      updateDragSelection(edgeRow, autoScrollState.col, ui.layoutMeta)
    }, intervalMs)
  }

  function handleMouseEvent(ev) {
    const action = classifySgrMouseEvent(ev)
    // 滚轮
    if (action === "wheel-up") { scrollBy(3); return }
    if (action === "wheel-down") { scrollBy(-3); return }

    const row = ev.y  // 1-based 屏幕行
    const col = ev.x  // 1-based 屏幕列
    const layout = ui.layoutMeta

    // Right-click copies the current application selection when the terminal
    // has delegated mouse input to KK Code.
    if (action === "secondary-press" && ui.mouseSelection) {
      finishSelection(true)
      return
    }

    // 左键按下 (button 0, press)
    if (action === "primary-press") {
      // 清除之前的选择
      clearSelections()
      // 点击输入区 → 定位光标 + 准备拖拽
      if (isScreenRowWithin(row, layout.inputStartRow, layout.inputEndRow)) {
        handleInputClick(row, col, layout)
        return
      }
      // 点击日志区 → 开始文本选择。落在状态栏/输入框等区域时不建选区，
      // 否则自动滚动会把这些行一起选进去。
      if (!isScreenRowWithin(row, layout.logStartRow, layout.logEndRow)) return
      const anchorAbs = absoluteRowFromScreen(row, layout)
      ui.mouseSelection = {
        startRow: row, startCol: col,
        endRow: row, endCol: col,
        startAbs: anchorAbs, endAbs: anchorAbs,
        active: true,
        moved: false
      }
      return
    }

    // 左键拖拽 (button 32 = motion with left held)
    if (action === "primary-drag") {
      // 日志区拖拽
      if (ui.mouseSelection?.active) {
        updateDragSelection(row, col, layout)
        updateAutoScroll(row, col, layout)
        return
      }
      // 输入框拖拽选择
      if (ui.inputDragAnchor >= 0 && isScreenRowWithin(row, layout.inputStartRow, layout.inputEndRow)) {
        const pos = inputCharFromScreen(row, col, layout)
        const anchor = ui.inputDragAnchor
        ui.inputSelection = {
          start: Math.min(anchor, pos),
          end: Math.max(anchor, pos)
        }
        ui.inputCursor = pos
        return
      }
      return
    }

    // 左键释放 (button 0, release)
    if (action === "primary-release") {
      // 日志区选择完成
      if (ui.mouseSelection?.active) {
        stopAutoScroll()
        updateDragSelection(row, col, layout)
        ui.mouseSelection.active = false
        finishSelection()
        return
      }
      // 输入框拖拽结束
      if (ui.inputDragAnchor >= 0) {
        ui.inputDragAnchor = -1
        // 如果没有实际选择范围，清除 inputSelection
        if (ui.inputSelection && ui.inputSelection.start === ui.inputSelection.end) {
          ui.inputSelection = null
        }
        return
      }
    }
  }

  // 屏幕坐标 → 输入框字符位置
  function inputCharFromScreen(row, col, layout) {
    const textCol = Math.max(0, col - layout.inputInnerOffset)
    const inputLineIdx = row - layout.inputStartRow
    if (inputLineIdx < 0) return 0
    return Math.min(
      ui.input.length,
      inputIndexAtPosition(ui.inputLayout, inputLineIdx, textCol)
    )
  }

  // 点击输入框 → 定位光标到对应位置
  function handleInputClick(row, col, layout) {
    if (ui.busy) return
    ui.inputCursor = inputCharFromScreen(row, col, layout)
    ui.inputSelection = null
    ui.inputDragAnchor = ui.inputCursor
    requestRender()
  }

  // 清除所有选择状态
  function clearSelections() {
    stopAutoScroll()
    ui.mouseSelection = null
    ui.inputSelection = null
    ui.inputDragAnchor = -1
    if (selectionClearTimer) {
      clearTimeout(selectionClearTimer)
      selectionClearTimer = null
    }
  }

  // 删除输入框中选中的文本，返回 true 表示有选择被删除
  function deleteInputSelection() {
    const sel = ui.inputSelection
    if (!sel || sel.start === sel.end) return false
    const s = Math.min(sel.start, sel.end)
    const e = Math.max(sel.start, sel.end)
    ui.input = ui.input.slice(0, s) + ui.input.slice(e)
    ui.inputCursor = s
    ui.inputSelection = null
    ui.inputDragAnchor = -1
    onInputChanged()
    return true
  }

  // 完成文本选择 → 根据 autoCopy 决定是否复制
  function finishSelection(forceCopy = false) {
    const sel = ui.mouseSelection
    if (!sel) return
    if (!_lastFrame?.lines) { ui.mouseSelection = null; return }

    // 行用 transcript 绝对行而非屏幕行：边选边滚之后屏幕行下的内容已经
    // 换了，只有绝对行还指向用户当初框住的那几行。
    const {
      startRow: r1,
      startCol: c1,
      endRow: r2,
      endCol: c2,
      isClick
    } = normalizeMouseSelection({
      startRow: (sel.startAbs ?? 0) + 1,
      startCol: sel.startCol,
      endRow: (sel.endAbs ?? 0) + 1,
      endCol: sel.endCol,
      moved: sel.moved
    })

    // 如果起止相同，视为单击而非选择
    if (isClick) {
      const screenRow = screenRowFromAbsolute(r1, ui.layoutMeta)
      const hit = screenRow === null ? null : ui.layoutMeta.transcriptHitRegions?.find((region) =>
        region.row === screenRow &&
        c1 + 1 >= region.columnStart &&
        c1 + 1 <= region.columnEnd
      )
      if (hit?.itemId && hit.action === "toggle") {
        transcript.toggleLog(hit.itemId)
      }
      ui.mouseSelection = null
      return
    }

    // autoCopy 开启时提取文本并复制
    if (ui.autoCopy || forceCopy) {
      const lines = []
      const transcriptLines = ui.layoutMeta.transcriptLines || []
      for (let r = r1; r <= r2; r++) {
        const plain = stripAnsi(String(transcriptLines[r] ?? ""))
        if (r === r1 && r === r2) {
          lines.push(splitTextByCellRange(plain, c1, c2).selected)
        } else if (r === r1) {
          lines.push(splitTextByCellRange(plain, c1, displayWidth(plain)).selected)
        } else if (r === r2) {
          lines.push(splitTextByCellRange(plain, 0, c2).selected)
        } else {
          lines.push(plain)
        }
      }
      const selectedText = lines.join("\n").trimEnd()
      if (selectedText) void copyToClipboard(selectedText)
      // 短暂保留高亮后清除
      if (selectionClearTimer) clearTimeout(selectionClearTimer)
      selectionClearTimer = setTimeout(() => {
        selectionClearTimer = null
        ui.mouseSelection = null
        requestRender()
      }, 200)
    }
    // autoCopy 关闭时：保留高亮，等待下次点击或按键清除
  }

  function cancelPendingFrame() {
    if (renderTimer) clearTimeout(renderTimer)
    renderTimer = null
    renderScheduled = false
  }

  function detachTuiInputListeners() {
    if (onKey) process.stdin.removeListener("keypress", onKey)
    if (onData) process.stdin.removeListener("data", onData)
  }

  function attachTuiInputListeners() {
    if (onKey) {
      process.stdin.removeListener("keypress", onKey)
      process.stdin.on("keypress", onKey)
    }
    if (onData) {
      process.stdin.removeListener("data", onData)
      process.stdin.on("data", onData)
    }
  }

  /**
   * Stop all application-owned terminal behavior before borrowing the normal
   * screen, suspending the process, or exiting. Pausing stdin on final teardown
   * is essential because readline's internal keypress decoder keeps a data
   * listener installed and otherwise refs the TTY handle indefinitely.
   */
  function deactivateTerminal({ pauseInput = false } = {}) {
    terminalSuspended = true
    cancelPendingFrame()
    cancelProtocolFlush()
    clipboardAbortController?.abort()
    clipboardAbortController = null
    detachTuiInputListeners()

    if (rawModeActive && process.stdin.isTTY) {
      try { process.stdin.setRawMode(false) } catch {}
    }
    rawModeActive = false

    if (stdinEmitPatched) {
      process.stdin.emit = _origStdinEmit
      stdinEmitPatched = false
    }
    mouseDecoder.reset()
    pasteDecoder.reset()
    plainTextDecoder.reset()

    if (terminalFrameActive) {
      terminalFrameActive = false
      try { stopTuiFrame(terminalFeatures) } catch {}
    }
    if (pauseInput) {
      try { process.stdin.pause() } catch {}
    }
  }

  function activateTerminal({ repaint = false } = {}) {
    if (disposed || terminalFrameActive) return false
    terminalSuspended = true
    try {
      startTuiFrame(terminalFeatures)
      terminalFrameActive = true
      if (!keypressDecoderStarted) {
        emitKeypressEvents(process.stdin, {
          escapeCodeTimeout: KEYPRESS_ESCAPE_TIMEOUT_MS
        })
        keypressDecoderStarted = true
      }
      process.stdin.emit = interceptStdinEmit
      stdinEmitPatched = true
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true)
        rawModeActive = true
      }
      attachTuiInputListeners()
      process.stdin.resume()
      terminalSuspended = false
      if (repaint) {
        forceFullPaint = true
        paintFrame(buildFrame())
      }
      return true
    } catch (error) {
      deactivateTerminal({ pauseInput: true })
      throw error
    }
  }

  /**
   * Temporarily return ownership to a cooked-mode prompt without allowing
   * timers, resize handlers, toasts, or EventBus callbacks to paint over it.
   */
  async function withSuspendedTui(fn) {
    const shouldResumeSpinner = Boolean(spinnerTimer)
    stopBusySpinner()
    deactivateTerminal()
    try {
      return await fn()
    } finally {
      // A termination signal may have completed the outer REPL while the
      // borrowed prompt was still awaiting input. Never resurrect the TUI.
      if (!disposed && activateTerminal({ repaint: true }) && shouldResumeSpinner && ui.busy) {
        startBusySpinner()
      }
    }
  }

  function continueAfterJobControl() {
    if (!jobControlSuspended) return
    jobControlSuspended = false
    if (onSuspend && process.platform !== "win32") {
      process.on("SIGTSTP", onSuspend)
    }
    if (
      !disposed &&
      resumeTerminalAfterContinue &&
      activateTerminal({ repaint: true }) &&
      resumeSpinnerAfterContinue &&
      ui.busy
    ) {
      startBusySpinner()
    }
    resumeTerminalAfterContinue = false
    resumeSpinnerAfterContinue = false
  }

  function suspendForJobControl() {
    if (disposed || jobControlSuspended || process.platform === "win32") return
    jobControlSuspended = true
    resumeTerminalAfterContinue = terminalFrameActive
    resumeSpinnerAfterContinue = Boolean(spinnerTimer) && terminalFrameActive
    stopBusySpinner()
    // 挂起期间收不到鼠标事件，自动滚动必须停，否则恢复后仍在滚
    stopAutoScroll()
    deactivateTerminal({ pauseInput: true })

    // Consume the first SIGTSTP so terminal state can be restored, then resend
    // it with the default disposition. SIGCONT reactivates the application.
    if (onSuspend) process.removeListener("SIGTSTP", onSuspend)
    try {
      process.kill(process.pid, "SIGTSTP")
    } catch {
      continueAfterJobControl()
    }
  }

  // Install Unix job-control handlers before entering the alternate screen.
  // Painting the first frame can be comparatively slow under coverage or on a
  // loaded machine; SIGTSTP must still restore terminal state during that gap.
  onSuspend = suspendForJobControl
  onContinue = continueAfterJobControl
  if (process.platform !== "win32") {
    process.on("SIGTSTP", onSuspend)
    process.on("SIGCONT", onContinue)
  }

  try {
    // `exit` is the last synchronous point at which Node can give the shell
    // back a usable terminal after process.exit() or an uncaught exception.
    // Keep this guard installed before entering the alternate screen so even
    // a startup failure cannot strand raw mode, mouse tracking, or the cursor.
    onProcessExit = () => {
      deactivateTerminal()
    }
    process.on("exit", onProcessExit)
    setPermissionPromptHandler(({ tool, sessionId, reason = "", pattern = "*", command = "", args = {}, risk = 0, defaultAction = "deny" }) =>
      new Promise((resolve) => {
        queuePermissionPrompt({
          tool,
          sessionId,
          reason,
          pattern,
          command,
          args,
          risk,
          defaultAction,
          resolve
        })
      })
    )
    PermissionEngine.setPersistGrantHandler(async ({ tool, pattern, command, workspace }) => {
      const result = await persistLearnedGrant({ ctx, tool, pattern, command, workspace })
      if (result.added) {
        showToast(`Always allow · ${describeRule(result.rule)}`, { topic: "permission", tone: "success" })
      } else if (result.reason === "limit") {
        showToast(`习得规则已达上限，请先 /permission forget`, { topic: "permission", tone: "warn" })
      }
      return result.added
    })
    setQuestionPromptHandler(({ questions }) =>
      new Promise((resolve) => {
        queueQuestionPrompt({ questions, resolve })
      })
    )
    activateTerminal()
    paintFrame(buildFrame())
  } catch (error) {
    disposed = true
    cancelPendingFrame()
    if (selectionClearTimer) clearTimeout(selectionClearTimer)
    stopAutoScroll()
    textStreamBatcher.dispose()
    ghostPredictor.dispose()
    deactivateTerminal({ pauseInput: true })
    setPermissionPromptHandler(null)
    setQuestionPromptHandler(null)
    stopBusySpinner()
    activityRenderer.stop()
    uiEventUnsub()
    transcriptUnsub()
    toastUnsub()
    toastStore.dispose()
    await saveHistoryLines(HIST_FILE, HIST_SIZE, ui.history).catch(() => {})
    if (onProcessExit) {
      process.removeListener("exit", onProcessExit)
      onProcessExit = null
    }
    if (process.platform !== "win32") {
      if (onSuspend) process.removeListener("SIGTSTP", onSuspend)
      if (onContinue) process.removeListener("SIGCONT", onContinue)
    }
    throw error
  }

  try {
    await new Promise((resolve) => {
      let finished = false
      const finish = () => {
        if (finished) return
        ui.quitting = true
        abortTurnAndPromptsForExit()
        finished = true
        resolve()
      }

      onResize = () => {
        // 浮层内容若是按内宽排版出来的（自带边框的面板），resize 后必须重排 ——
        // 否则新宽度下它的边框会被外层折行折断。
        if (ui.infoPanel?.source) {
          const innerWidth = Math.max(20, (Number(process.stdout.columns) || 120) - 4)
          if (innerWidth !== ui.infoPanel.renderedAt) {
            const resolved = ui.infoPanel.source(innerWidth)
            ui.infoPanel.lines = String(resolved ?? "").split("\n")
            ui.infoPanel.renderedAt = innerWidth
            ui.infoPanel.offset = 0
          }
        }
        requestRender({ force: true })
      }
      onKey = async (str, key = {}) => {
        if (ui.quitting) return

        if (key.ctrl && key.name === "z" && process.platform !== "win32") {
          suspendForJobControl()
          return
        }

        // A visible selection owns Ctrl+C. With no selection, Ctrl+C keeps its
        // established interrupt/exit behavior.
        if (key.ctrl && key.name === "c" && ui.mouseSelection) {
          finishSelection(true)
          requestRender()
          return
        }
        if (key.ctrl && key.name === "c" && ui.inputSelection) {
          const start = Math.min(ui.inputSelection.start, ui.inputSelection.end)
          const end = Math.max(ui.inputSelection.start, ui.inputSelection.end)
          void copyToClipboard(ui.input.slice(start, end))
          requestRender()
          return
        }

        // 任意按键清除日志区鼠标选择（不清除输入框选择，由具体按键处理）
        if (ui.mouseSelection) {
          ui.mouseSelection = null
          requestRender()
        }

        if (key.ctrl && key.name === "c") {
          // Busy: abort current turn (same as ESC)
          if (ui.busy) {
            if (ui.turnAbortController) {
              ui.turnAbortController.abort()
              ui.turnAbortController = null
            }
            ui.paused = true
            appendLog(state.mode === "agent"
              ? "[paused] agent turn interrupted — enter a follow-up message to continue the same task"
              : "[paused] turn interrupted — enter a new message or command to continue")
            requestRender()
            return
          }
          // Idle: require double Ctrl+C within 2s to exit
          const now = Date.now()
          if (now - ui.lastCtrlCTime < 2000) {
            finish()
          } else {
            ui.lastCtrlCTime = now
            showToast("Press Ctrl+C again to exit", { topic: "exit", tone: "warning" })
            requestRender()
          }
          return
        }

        if (key.ctrl && key.name === "d" && ui.input.length === 0) {
          finish()
          return
        }

        // 信息浮层排在所有浮层之前：它是模态的，打开时应吃掉导航键，
        // 否则 ↑↓ 会同时滚浮层和翻输入历史。
        if (ui.infoPanel) {
          if (key.name === "escape" || (key.ctrl && key.name === "c") || key.name === "q") {
            closeInfoPanel()
            return
          }
          if (key.name === "up") { scrollInfoPanel(-1); return }
          if (key.name === "down") { scrollInfoPanel(1); return }
          if (key.name === "pageup") { scrollInfoPanel(-Math.max(1, (ui.infoPanel.maxRows || 14) - 1)); return }
          if (key.name === "pagedown") { scrollInfoPanel(Math.max(1, (ui.infoPanel.maxRows || 14) - 1)); return }
          if (key.name === "home") { scrollInfoPanel(-Number.MAX_SAFE_INTEGER); return }
          if (key.name === "end") { scrollInfoPanel(Number.MAX_SAFE_INTEGER); return }
          // Enter 也关：读完就走是最常见的动作，不该只有 Esc 一条路
          if (key.name === "return" || key.name === "enter") { closeInfoPanel(); return }
          // 其余按键忽略，避免在浮层打开时误改输入框
          return
        }

        if (ui.pendingPermission) {
          const PERM_VALUES = PERMISSION_PROMPT_VALUES
          if (["1", "2", "3", "4"].includes(str)) {
            resolvePermissionPrompt(PERM_VALUES[Number(str) - 1])
            return
          }
          if (key.name === "escape") {
            resolvePermissionPrompt("deny")
            return
          }
          if (key.name === "return") {
            resolvePermissionPrompt(PERM_VALUES[ui.permissionSelected] || "deny")
            return
          }
          if (key.name === "up") {
            ui.permissionSelected = Math.max(0, ui.permissionSelected - 1)
            requestRender()
            return
          }
          if (key.name === "down") {
            ui.permissionSelected = Math.min(PERM_VALUES.length - 1, ui.permissionSelected + 1)
            requestRender()
            return
          }
          return
        }

        if (ui.pendingQuestion) {
          const questions = ui.pendingQuestion.questions || []
          const currentQ = questions[ui.questionIndex] || {}
          const options = Array.isArray(currentQ.options) ? currentQ.options : []
          const maxOptIdx = options.length + (currentQ.allowCustom !== false ? 1 : 0) - 1

          // Ctrl+Enter: submit all answers immediately
          if (key.ctrl && key.name === "return") {
            commitCurrentQuestionAnswer()
            resolveQuestionPrompt()
            return
          }

          if (ui.questionCustomMode || options.length === 0) {
            // Custom text input mode / free text question
            if (key.name === "escape" && options.length > 0) {
              // Back to options list
              ui.questionCustomMode = false
              requestRender()
              return
            }
            if (key.name === "escape" && options.length === 0) {
              // Skip this question
              ui.questionAnswers[currentQ.id] = "(skipped)"
              if (ui.questionIndex < questions.length - 1) {
                ui.questionIndex += 1
                ui.questionCustomInput = ""
                ui.questionCustomCursor = 0
              } else {
                resolveQuestionPrompt()
              }
              requestRender()
              return
            }
            if (key.name === "return") {
              ui.questionAnswers[currentQ.id] = ui.questionCustomInput || ""
              ui.questionCustomMode = false
              ui.questionCustomInput = ""
              ui.questionCustomCursor = 0
              if (ui.questionIndex < questions.length - 1) {
                ui.questionIndex += 1
                ui.questionOptionSelected = 0
              } else {
                resolveQuestionPrompt()
              }
              requestRender()
              return
            }
            if (key.name === "backspace") {
              if (ui.questionCustomCursor > 0) {
                const previous = moveGraphemeCursor(
                  ui.questionCustomInput,
                  ui.questionCustomCursor,
                  -1
                )
                const before = ui.questionCustomInput.slice(0, previous)
                const after = ui.questionCustomInput.slice(ui.questionCustomCursor)
                ui.questionCustomInput = before + after
                ui.questionCustomCursor = previous
              }
              requestRender()
              return
            }
            if (key.name === "left") {
              ui.questionCustomCursor = moveGraphemeCursor(
                ui.questionCustomInput,
                ui.questionCustomCursor,
                -1
              )
              requestRender()
              return
            }
            if (key.name === "right") {
              ui.questionCustomCursor = moveGraphemeCursor(
                ui.questionCustomInput,
                ui.questionCustomCursor,
                1
              )
              requestRender()
              return
            }
            // Printable character
            if (
              str &&
              !key.ctrl &&
              !key.meta &&
              !/[\u0000-\u001f\u007f-\u009f]/u.test(str)
            ) {
              insertQuestionText(str)
              requestRender()
              return
            }
            return
          }

          // Options mode
          if (key.name === "escape") {
            // Skip current question
            ui.questionAnswers[currentQ.id] = "(skipped)"
            if (ui.questionIndex < questions.length - 1) {
              ui.questionIndex += 1
              ui.questionOptionSelected = 0
            } else {
              resolveQuestionPrompt()
            }
            requestRender()
            return
          }
          if (key.name === "up") {
            ui.questionOptionSelected = Math.max(0, ui.questionOptionSelected - 1)
            requestRender()
            return
          }
          if (key.name === "down") {
            ui.questionOptionSelected = Math.min(maxOptIdx, ui.questionOptionSelected + 1)
            requestRender()
            return
          }
          if (key.name === "tab") {
            // Switch between questions
            if (key.shift) {
              ui.questionIndex = ui.questionIndex > 0 ? ui.questionIndex - 1 : questions.length - 1
            } else {
              ui.questionIndex = (ui.questionIndex + 1) % questions.length
            }
            ui.questionOptionSelected = 0
            ui.questionCustomMode = false
            requestRender()
            return
          }
          if (key.name === "space" && currentQ.multi) {
            // Toggle multi-select checkbox
            if (ui.questionOptionSelected < options.length) {
              if (!ui.questionMultiSelected[currentQ.id]) {
                ui.questionMultiSelected[currentQ.id] = new Set()
              }
              const set = ui.questionMultiSelected[currentQ.id]
              if (set.has(ui.questionOptionSelected)) {
                set.delete(ui.questionOptionSelected)
              } else {
                set.add(ui.questionOptionSelected)
              }
              requestRender()
            }
            return
          }
          if (key.name === "return") {
            // Custom... option selected
            if (ui.questionOptionSelected === options.length && currentQ.allowCustom !== false) {
              ui.questionCustomMode = true
              ui.questionCustomInput = ""
              ui.questionCustomCursor = 0
              requestRender()
              return
            }
            // Regular option selected
            advanceOrSubmitQuestion()
            return
          }
          return
        }

        // provider 选择器：注意它的 items 是结构化对象数组。行模式下
        // ui.providerPicker 会被设成字符串数组（编号输入态），那种形态没有
        // items 字段，不该走这里 —— 用 Array.isArray(items) 区分。
        if (ui.providerPicker && Array.isArray(ui.providerPicker.items)) {
          if (key.name === "escape") {
            closeProviderPicker()
            return
          }
          if (key.name === "return") {
            void confirmProviderPicker()
            return
          }
          if (key.name === "up") {
            ui.providerPicker.selected = Math.max(0, ui.providerPicker.selected - 1)
            requestRender()
            return
          }
          if (key.name === "down") {
            ui.providerPicker.selected = Math.min(ui.providerPicker.items.length - 1, ui.providerPicker.selected + 1)
            requestRender()
            return
          }
          return
        }

        if (ui.sessionPicker && Array.isArray(ui.sessionPicker.items)) {
          if (key.name === "escape") {
            closeSessionPicker()
            return
          }
          if (key.name === "return") {
            void confirmSessionPicker()
            return
          }
          if (key.name === "up") {
            ui.sessionPicker.selected = Math.max(0, ui.sessionPicker.selected - 1)
            requestRender()
            return
          }
          if (key.name === "down") {
            ui.sessionPicker.selected = Math.min(ui.sessionPicker.items.length - 1, ui.sessionPicker.selected + 1)
            requestRender()
            return
          }
          return
        }

        if (ui.modelPicker) {
          if (key.name === "escape") {
            closeModelPicker()
            return
          }
          if (key.name === "return") {
            confirmModelPicker()
            return
          }
          if (key.name === "up") {
            ui.modelPicker.selected = Math.max(0, ui.modelPicker.selected - 1)
            requestRender()
            return
          }
          if (key.name === "down") {
            ui.modelPicker.selected = Math.min(ui.modelPicker.items.length - 1, ui.modelPicker.selected + 1)
            requestRender()
            return
          }
          return
        }

        if (ui.policyPicker) {
          if (key.name === "escape") {
            closePolicyPicker()
            return
          }
          if (key.name === "return") {
            confirmPolicyPicker()
            return
          }
          if (key.name === "up") {
            ui.policyPicker.selected = Math.max(0, ui.policyPicker.selected - 1)
            requestRender()
            return
          }
          if (key.name === "down") {
            ui.policyPicker.selected = Math.min(POLICY_CHOICES.length - 1, ui.policyPicker.selected + 1)
            requestRender()
            return
          }
          return
        }

        if (ui.modePicker) {
          if (key.name === "escape") {
            closeModePicker()
            return
          }
          if (key.name === "return") {
            confirmModePicker()
            return
          }
          if (key.name === "tab") {
            // 面板打开时 Shift+Tab 继续循环，手感与关闭时一致
            const delta = key.shift ? 1 : -1
            const count = MODE_PICKER_CHOICES.length
            ui.modePicker.selected = (ui.modePicker.selected + delta + count) % count
            requestRender()
            return
          }
          if (key.name === "up") {
            ui.modePicker.selected = Math.max(0, ui.modePicker.selected - 1)
            requestRender()
            return
          }
          if (key.name === "down") {
            ui.modePicker.selected = Math.min(MODE_PICKER_CHOICES.length - 1, ui.modePicker.selected + 1)
            requestRender()
            return
          }
          return
        }

        // Scrolling keys work even when busy
        if (key.name === "pageup") {
          scrollBy(pageSize(ui.scrollMeta.logRows))
          requestRender()
          return
        }

        if (key.name === "pagedown") {
          scrollBy(-pageSize(ui.scrollMeta.logRows))
          requestRender()
          return
        }

        // Ctrl+Up/Down: scroll log area (3 lines at a time)
        if (key.ctrl && (key.name === "up" || key.name === "down")) {
          scrollBy(key.name === "up" ? 3 : -3)
          requestRender()
          return
        }

        if (key.name === "home" && (key.ctrl || key.shift)) {
          scrollToTop()
          requestRender()
          return
        }

        if (key.name === "end" && (key.ctrl || key.shift)) {
          scrollToBottom()
          requestRender()
          return
        }

        // Esc while busy: pause current turn
        if (key.name === "escape" && ui.busy) {
          if (ui.turnAbortController) {
            ui.turnAbortController.abort()
            ui.turnAbortController = null
          }
          ui.paused = true
          appendLog(state.mode === "agent"
            ? "[paused] agent turn interrupted — enter a follow-up message to continue the same task"
            : "[paused] turn interrupted — enter a new message or command to continue")
          requestRender()
          return
        }

        if (ui.busy) return

        // Ctrl+V: try image first, fall back to text paste
        if (key.ctrl && key.name === "v") {
          showToast("Reading clipboard…", { topic: "clipboard", tone: "info", durationMs: 0 })
          requestRender()
          const clipBlock = await readClipboardImage({
            onStatus: (msg) => {
              if (msg) showToast(msg, { topic: "clipboard", tone: "info", durationMs: 0 })
              requestRender()
            }
          })
          if (clipBlock && clipBlock.type === "image") {
            ui.pendingImages.push(clipBlock)
            showToast(`Image pasted · ${ui.pendingImages.length} attached`, {
              topic: "clipboard",
              tone: "success"
            })
            requestRender()
            return
          }
          if (clipBlock && clipBlock.type === "error") {
            showToast(`Paste failed: ${clipBlock.message}`, {
              topic: "clipboard",
              tone: "error",
              durationMs: 5000
            })
            requestRender()
            return
          }
          // No image — try text clipboard
          const clipText = await readClipboardText()
          if (clipText) {
            insertAtCursor(clipText)
            showToast("Text pasted", { topic: "clipboard", tone: "success" })
          } else {
            showToast("Clipboard is empty", { topic: "clipboard", tone: "warning" })
          }
          requestRender()
          return
        }

        if (key.name === "return") {
          if (key.shift) {
            insertAtCursor("\n")
            requestRender()
            return
          }
          if (shouldApplySuggestionOnEnter()) {
            applyCurrentSuggestion()
            ui.selectedSuggestion = 0
            ui.suggestionOffset = 0
            requestRender()
            return
          }
          await submitCurrentInput()
          if (ui.quitting) finish()
          return
        }

        if (key.ctrl && key.name === "j") {
          insertAtCursor("\n")
          requestRender()
          return
        }

        if (key.name === "backspace") {
          if (!deleteInputSelection() && ui.inputCursor > 0) {
            const previousCursor = moveGraphemeCursor(ui.input, ui.inputCursor, -1)
            const head = ui.input.slice(0, previousCursor)
            const tail = ui.input.slice(ui.inputCursor)
            ui.input = `${head}${tail}`
            ui.inputCursor = previousCursor
            onInputChanged()
          }
          ui.selectedSuggestion = 0
          ui.suggestionOffset = 0
          requestRender()
          return
        }

        if (key.name === "delete") {
          if (!deleteInputSelection()) {
            const nextCursor = moveGraphemeCursor(ui.input, ui.inputCursor, 1)
            const head = ui.input.slice(0, ui.inputCursor)
            const tail = ui.input.slice(nextCursor)
            ui.input = `${head}${tail}`
            onInputChanged()
          }
          ui.selectedSuggestion = 0
          ui.suggestionOffset = 0
          requestRender()
          return
        }

        if (key.name === "escape") {
          // 先撤掉 ghost，第二次 Esc 才清空输入
          if (ui.ghostText) {
            ui.ghostText = ""
            ghostPredictor?.cancel()
            requestRender()
            return
          }
          // 输入框已空时，连按两下 Esc 回溯上一轮对话。
          // 说错了、模型跑偏了、或只是想换个问法，应该能退回去重来，而不是
          // 被迫在一段已经歪掉的上下文里继续往前顶。
          // 只回溯对话，不动磁盘 —— 文件改动归 /undo，退一句话很轻，
          // 退一批文件改动有风险，不该被同一个手势同时触发。
          if (!ui.input) {
            const now = Date.now()
            if (ui.lastEscapeAt && now - ui.lastEscapeAt < DOUBLE_ESCAPE_MS) {
              ui.lastEscapeAt = 0
              void handleRewind()
              return
            }
            ui.lastEscapeAt = now
            showToast("再按一次 Esc 回溯上一轮", { topic: "rewind", tone: "info", durationMs: DOUBLE_ESCAPE_MS })
            requestRender()
            return
          }
          ui.input = ""
          ui.inputCursor = 0
          ui.selectedSuggestion = 0
          ui.suggestionOffset = 0
          ghostPredictor?.cancel()
          requestRender()
          return
        }

        if (key.name === "tab") {
          if (key.shift) {
            cycleModeForwardAndNotify()
            return
          }
          // Tab 早已被 slash 补全占用，仅在没有补全候选时才用于接受 ghost
          const hasSuggestions = slashSuggestions(ui.input, slashRouterOptions(localCustomCommands)).length > 0
          if (!hasSuggestions && acceptGhost()) return
          applyCurrentSuggestion()
          return
        }

        // Ctrl+F 无歧义地接受 ghost，不与补全争抢
        if (key.ctrl && key.name === "f") {
          acceptGhost()
          return
        }

        if (key.name === "left") {
          moveCursor(-1)
          requestRender()
          return
        }

        if (key.name === "right") {
          moveCursor(1)
          requestRender()
          return
        }

        if (key.name === "home") {
          if (key.ctrl || key.shift) {
            // Ctrl+Home or Shift+Home: scroll to top of logs
            scrollToTop()
            requestRender()
          } else {
            // Home: move input cursor to start
            setCursor(0)
            requestRender()
          }
          return
        }

        if (key.name === "end") {
          if (key.ctrl || key.shift) {
            // Ctrl+End or Shift+End: scroll to bottom of logs
            scrollToBottom()
            requestRender()
          } else {
            // End: move input cursor to end
            setCursor(ui.input.length)
            requestRender()
          }
          return
        }

        if (key.name === "up" || key.name === "down") {
          const handled = handleUpDownSuggestions(key.name)
          if (!handled) navigateHistory(key.name)
          requestRender()
          return
        }

        if (key.ctrl && key.name === "t") {
          if (ui.lastThinkingId) {
            transcript.toggleLog(ui.lastThinkingId)
            showToast("Thinking details toggled", { topic: "thinking", tone: "info" })
          } else {
            showToast("No thinking details in this turn", { topic: "thinking", tone: "info" })
          }
          requestRender()
          return
        }

        // Ctrl+O 与 Ctrl+E 并列绑定：折叠块该有多条路进得去（鼠标点击、
        // Ctrl+E、Ctrl+O），而不是只记得住一个组合键。
        if (key.ctrl && (key.name === "e" || key.name === "o")) {
          const expandable = transcript.getItems().findLast((item) => item.collapsible && item.details.length)
          if (expandable) {
            transcript.toggleLog(expandable.id)
            showToast(`${expandable.kind} details ${expandable.expanded ? "collapsed" : "expanded"}`, {
              topic: "details",
              tone: "info"
            })
          } else {
            showToast("No expandable details", { topic: "details", tone: "info" })
          }
          requestRender()
          return
        }

        if (key.ctrl && key.name === "b") {
          ui.showDashboard = !ui.showDashboard
          requestRender()
          return
        }

        if (key.ctrl && key.name === "y") {
          ui.autoCopy = !ui.autoCopy
          showToast(`Auto-copy ${ui.autoCopy ? "ON" : "OFF"}`, {
            topic: "auto-copy",
            tone: ui.autoCopy ? "success" : "info"
          })
          requestRender()
          return
        }

        if (key.ctrl && key.name === "l" && !key.shift) {
          transcript.clear()
          requestRender()
          return
        }

        if (typeof str === "string" && str.length > 0 && !key.ctrl && !key.meta) {
          deleteInputSelection()  // 有选择时先删除选中文本
          insertAtCursor(str)
          ui.selectedSuggestion = 0
          ui.suggestionOffset = 0
          requestRender()
        }
      }
      onData = async (chunk) => {
        if (ui.quitting) return
        if (ui.busy) return
        if (!hasShiftEnterSequence(chunk)) return
        insertAtCursor("\n")
        requestRender()
      }
      onSigint = () => {
        const now = Date.now()
        if (ui.busy) {
          if (ui.turnAbortController) {
            ui.turnAbortController.abort()
            ui.turnAbortController = null
          }
          ui.paused = true
          appendLog(state.mode === "agent"
            ? "[paused] agent turn interrupted — enter a follow-up message to continue the same task"
            : "[paused] turn interrupted — enter a new message or command to continue")
          requestRender()
          return
        }
        if (now - ui.lastCtrlCTime < 2000) {
          finish()
        } else {
          ui.lastCtrlCTime = now
          showToast("Press Ctrl+C again to exit", { topic: "exit", tone: "warning" })
          requestRender()
        }
      }
      onTerminate = finish
      onSigbreak = finish

      process.stdout.on("resize", onResize)
      attachTuiInputListeners()
      process.on("SIGINT", onSigint)
      process.on("SIGTERM", onTerminate)
      process.on("SIGHUP", onTerminate)
      if (process.platform === "win32") {
        process.on("SIGBREAK", onSigbreak)
      }
    })
  } finally {
    disposed = true
    abortTurnAndPromptsForExit()
    cancelPendingFrame()
    if (selectionClearTimer) clearTimeout(selectionClearTimer)
    stopAutoScroll()
    textStreamBatcher.dispose()
    ghostPredictor.dispose()
    stopBusySpinner()
    activityRenderer.stop()
    uiEventUnsub()
    transcriptUnsub()
    toastUnsub()
    toastStore.dispose()
    setPermissionPromptHandler(null)
    setQuestionPromptHandler(null)
    if (onResize) process.stdout.removeListener("resize", onResize)
    if (onKey) process.stdin.removeListener("keypress", onKey)
    if (onData) process.stdin.removeListener("data", onData)
    if (onSigint) process.removeListener("SIGINT", onSigint)
    if (onTerminate) {
      process.removeListener("SIGTERM", onTerminate)
      process.removeListener("SIGHUP", onTerminate)
    }
    if (process.platform === "win32") {
      if (onSigbreak) process.removeListener("SIGBREAK", onSigbreak)
    } else {
      if (onSuspend) process.removeListener("SIGTSTP", onSuspend)
      if (onContinue) process.removeListener("SIGCONT", onContinue)
    }
    deactivateTerminal({ pauseInput: true })
    if (onProcessExit) {
      process.removeListener("exit", onProcessExit)
      onProcessExit = null
    }
    await saveHistoryLines(HIST_FILE, HIST_SIZE, ui.history)
  }
}

export async function startRepl({ trust = false } = {}) {
  // First-run onboarding — must run before splash/readline to own the terminal
  const existingProfile = await loadProfile()
  if (!existingProfile || process.env.KKCODE_ONBOARDING === "1") {
    await runOnboarding()
  }

  // Trust check BEFORE splash — readline prompt must not compete with splash screen clearing
  const { checkWorkspaceTrust } = await import("./permission/workspace-trust.mjs")
  const trustState = await checkWorkspaceTrust({ cwd: process.cwd(), cliTrust: trust, isTTY: process.stdin.isTTY })

  const splash = startSplash({ version: `v${PACKAGE_VERSION}` })

  const ctx = await buildContext({ trust, trustState })
  printContextWarnings(ctx)
  // 不阻塞启动：命中本地缓存时会很快回填，preflight 读到什么就报什么
  let startupUpdateResult = null
  void maybeNotifyUpdateOnStartup(ctx.configState.config, { currentVersion: PACKAGE_VERSION })
    .then((result) => { startupUpdateResult = result })
    .catch(() => {})
  // 启动即异步刷新默认 provider 的模型目录（0.6.0）：让 /model 秒开、并把
  // API 自报的上下文长度合并进内存的 model_context。此前没有任何启动路径
  // 触发发现，列表与上限全靠上次手动 /model refresh 或人肉配置。
  // 绝不阻塞启动：失败静默，缓存 TTL 15 分钟由 catalog 层负责。
  {
    // 主题的 markdown 分组注入渲染器：换主题时对话里的 markdown 跟着变
  setMarkdownColors(ctx.themeState.theme?.markdown)
  const startupProvider = ctx.configState.config?.provider?.default
    if (startupProvider) {
      void loadProviderModelItems(ctx.configState, startupProvider).catch(() => {})
    }
  }
  const extensionPolicy = resolveExtensionPolicy(ctx.configState)

  splash.update("loading tools & MCP servers...")
  await ToolRegistry.initialize({
    config: extensionPolicy.config,
    cwd: process.cwd(),
    allowProjectSources: extensionPolicy.allowProjectSources
  })

  // Collect MCP status for later display
  const mcpHealth = McpRegistry.healthSnapshot()
  const mcpStatusLines = collectMcpStatusLines(ctx.themeState.theme, mcpHealth, McpRegistry.listTools())

  splash.update("loading skills & agents...")
  await SkillRegistry.initialize(extensionPolicy.config, process.cwd(), {
    allowProjectSources: extensionPolicy.allowProjectSources
  })
  const { CustomAgentRegistry } = await import("./agent/custom-agent-loader.mjs")
  await CustomAgentRegistry.initialize(process.cwd(), {
    allowProjectSources: extensionPolicy.allowProjectSources
  })

  splash.update("loading hooks & history...")
  await initHookBus(process.cwd(), extensionPolicy.config, {
    allowProjectSources: extensionPolicy.allowProjectSources
  })
  const historyLines = await loadHistoryLines(HIST_FILE, HIST_SIZE)

  splash.update("preparing workspace...")
  const state = createInitialReplState(ctx.configState.config, { newSessionIdFn: newSessionId })

  // Check if auto memory file exists
  try {
    await readFile(memoryFilePath(process.cwd()), "utf8")
    state.memoryLoaded = true
  } catch {
    state.memoryLoaded = false
  }

  const customCommands = await loadCustomCommands(process.cwd(), {
    allowProjectSources: extensionPolicy.allowProjectSources
  })
  const providersConfigured = configuredProviders(ctx.configState.config, listProviders)
  const recentSessions = await listSessions({ cwd: process.cwd(), limit: 6, includeChildren: false }).catch(() => [])

  // 启动自检：只看「现在能不能干活」的几项，重活留给 kkcode doctor
  const preflight = buildPreflightReport({
    configState: ctx.configState,
    mcp: McpRegistry.healthSnapshot?.() || mcpHealth,
    skills: { total: SkillRegistry.list?.().length || 0 },
    update: startupUpdateResult
  })

  splash.stop()

  PermissionEngine.setTrusted(ctx.trustState?.trusted !== false)
  if (!ctx.trustState?.trusted) {
    console.log(paint("  ⚠ workspace not trusted — tools are blocked. Run /trust to enable.", ctx.themeState.theme.semantic.warning))
  }
  // 只在有问题时打印，一切正常就不打扰。update 有自己的通知路径，不在这里重复。
  const preflightProblems = preflight.problems.filter((p) => p.name !== "update")
  if (preflightProblems.length) {
    const tone = preflightProblems.some((p) => p.status === "fail")
      ? ctx.themeState.theme.semantic.error || ctx.themeState.theme.semantic.warn
      : ctx.themeState.theme.semantic.warn
    console.log(paint("  preflight", tone, { bold: true }))
    for (const problem of preflightProblems) {
      console.log(paint(`    ${problem.status}  ${problem.name}: ${problem.detail}`, tone))
    }
  }

  try {
    await runReplController({
      ctx,
      state,
      providersConfigured,
      customCommands,
      recentSessions,
      historyLines,
      mcpStatusLines,
      startTuiRepl,
      startLineRepl,
      clearScreenFn: clearScreen
    })
  } finally {
    await McpRegistry.shutdown()
  }
}
