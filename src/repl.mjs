import { PACKAGE_VERSION } from "./version.mjs"
import { maybeNotifyUpdateOnStartup } from "./update/checker.mjs"
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
import { discoverModelsForProvider } from "./provider/model-catalog.mjs"
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
import { createActivityRenderer, formatPlanProgress } from "./ui/activity-renderer.mjs"
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
import {
  slashSuggestions,
  applySuggestionToInput,
  normalizeSlashAlias
} from "./repl/slash-router.mjs"
import { renderInstalledCommandSurface, describeReloadSummary } from "./repl/command-surface.mjs"
import { executePromptTurn } from "./repl/turn-controller.mjs"
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
import { approvalFromLegacy } from "./core/modes.mjs"
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
  clipAnsiByWidth,
  inputIndexAtPosition,
  layoutInputText,
  moveGraphemeCursor,
  splitGraphemes,
  splitTextByCellRange,
  terminalCellWidth,
  wrapAnsiLine
} from "./repl/text-layout.mjs"
import { copyTerminalText, copyableFrameLine } from "./repl/clipboard.mjs"
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
import {
  sanitizeTerminalStyledText,
  sanitizeTerminalText,
  sanitizeTerminalValue
} from "./theme/terminal-sanitize.mjs"

const HIST_DIR = userRootDir()
const HIST_FILE = join(HIST_DIR, "repl_history")
const HIST_SIZE = 500
const MAX_TUI_LOG_LINES = 1200
const MAX_TUI_SUGGESTIONS = 5
const MAX_MODEL_PICKER_VISIBLE = 8
const TUI_FRAME_MS = 16
const ANSI_RE = /\x1B\[[0-9;]*m/g
const SCROLL_PAGE_RATIO = 0.75
const BUSY_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const ESCAPE_SEQUENCE_TIMEOUT_MS = 35
const KEYPRESS_ESCAPE_TIMEOUT_MS = 10

function clipBusy(text, max) {
  const s = String(text || "").trim().split("\n")[0]
  return s.length > max ? s.slice(0, max - 3) + "..." : s
}

function formatBusyToolDetail(toolName, args) {
  if (!args) return ""
  switch (toolName) {
    case "bash": return args.command ? paint(` ${clipBusy(args.command, 60)}`, null, { dim: true }) : ""
    case "read": return args.path ? paint(` ${clipBusy(args.path, 60)}`, null, { dim: true }) : ""
    case "write": return args.path ? paint(` ${clipBusy(args.path, 60)}`, null, { dim: true }) : ""
    case "edit": return args.path ? paint(` ${clipBusy(args.path, 60)}`, null, { dim: true }) : ""
    case "notebookedit": return args.path ? paint(` ${clipBusy(args.path, 50)} cell ${args.cell_number ?? 0}`, null, { dim: true }) : ""
    case "grep": return args.pattern ? paint(` ${clipBusy(args.pattern, 40)}`, null, { dim: true }) : ""
    case "glob": return args.pattern ? paint(` ${clipBusy(args.pattern, 40)}`, null, { dim: true }) : ""
    case "patch": return args.path ? paint(` ${clipBusy(args.path, 40)} L${args.start_line || "?"}-${args.end_line || "?"}`, null, { dim: true }) : ""
    case "task": return args.description ? paint(` ${clipBusy(args.description, 50)}`, null, { dim: true }) : ""
    case "enter_plan": return args.reason ? paint(` ${clipBusy(args.reason, 50)}`, null, { dim: true }) : paint(" planning...", null, { dim: true })
    case "exit_plan": return paint(" submitting plan...", null, { dim: true })
    default: return ""
  }
}

const BUILTIN_SLASH = [
  { name: "help", desc: "show help" },
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
  { name: "longagent", desc: "persistent staged development" },
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
  { name: "exit", desc: "quit" }
]

function stripAnsi(text) {
  return String(text || "").replace(ANSI_RE, "")
}

function displayWidth(text) {
  return terminalCellWidth(text)
}

function clipPlainByWidth(text, maxWidth) {
  if (maxWidth <= 0) return ""
  let out = ""
  let used = 0
  for (const segment of splitGraphemes(String(text || ""))) {
    const w = terminalCellWidth(segment.text)
    if (used + w > maxWidth) break
    out += segment.text
    used += w
  }
  return out
}

function padRight(text, width) {
  const raw = stripAnsi(text)
  const used = displayWidth(raw)
  if (used >= width) return clipPlainByWidth(raw, width)
  return raw + " ".repeat(width - used)
}

function clipAnsiLine(text, width) {
  const raw = stripAnsi(text)
  const used = displayWidth(raw)
  if (used <= width) return `${String(text || "")}${" ".repeat(Math.max(0, width - used))}`
  if (width <= 1) return clipAnsiByWidth(text, Math.max(0, width))
  return `${clipAnsiByWidth(text, width - 1)}~`
}

function wrapPlainLine(text, width) {
  const raw = stripAnsi(text)
  if (width <= 0) return [""]
  if (!raw) return [""]
  const out = []
  let rest = raw
  while (displayWidth(rest) > width) {
    const chunk = clipPlainByWidth(rest, width)
    out.push(chunk)
    rest = rest.slice(chunk.length)
  }
  out.push(rest)
  return out
}

function wrapLogLines(lines, width, maxRows = null) {
  const wrapped = []
  for (const line of lines) {
    const parts = wrapAnsiLine(line, width)
    for (const part of parts) wrapped.push(part)
  }
  if (!Number.isInteger(maxRows) || maxRows < 0) return wrapped
  if (wrapped.length <= maxRows) return wrapped
  return wrapped.slice(wrapped.length - maxRows)
}

function frameTop(width, color) {
  return paint(`┌${"─".repeat(Math.max(1, width - 2))}┐`, color)
}

function frameBottom(width, color) {
  return paint(`└${"─".repeat(Math.max(1, width - 2))}┘`, color)
}

function frameDivider(width, color) {
  return paint(`├${"─".repeat(Math.max(1, width - 2))}┤`, color)
}

function frameRow(content, width, color) {
  const inner = Math.max(1, width - 4)
  const left = paint("│ ", color)
  const right = paint(" │", color)
  return `${left}${clipAnsiLine(content, inner)}${right}`
}

function pageSize(rows) {
  return Math.max(1, Math.floor(rows * SCROLL_PAGE_RATIO))
}

function ageLabel(ms) {
  const mins = Math.round(ms / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

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

function mergeObject(base, override) {
  if (override === undefined || override === null) return base
  if (Array.isArray(override)) return [...override]
  if (!base || typeof base !== "object" || Array.isArray(base)) return override
  if (typeof override !== "object") return override
  const out = { ...base }
  for (const key of Object.keys(override)) {
    out[key] = mergeObject(base[key], override[key])
  }
  return out
}

function pickConfigPathForScope(scope, source, cwd = process.cwd()) {
  if (scope === "user") return source?.userPath || userConfigCandidates()[0]
  if (scope === "project") return source?.projectPath || projectConfigCandidates(cwd)[0]
  return null
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
  print,
  streamSink = null,
  showTurnStatus = true,
  pendingImages = [],
  clearPendingImages = null,
  signal = null,
  suspendTui = null
}) {
  let normalized = normalizeSlashAlias(String(line || "").trim())

  // --- 向导模式：拦截所有输入 ---
  if (wizard?.active) {
    const result = await handleWizardInput(wizard, line, print)
    if (result.done && setWizard) setWizard({ ...wizard })
    // 热更新内存中的 config
    if (result.configPatch?.provider) {
      if (!ctx.configState.config.provider) ctx.configState.config.provider = {}
      Object.assign(ctx.configState.config.provider, result.configPatch.provider)
      if (result.configPatch.provider.default) {
        ctx.configState.config.provider.default = result.configPatch.provider.default
      }
    }
    return { exit: false }
  }

  if (!normalized) return { exit: false }
  if (normalized === "/") return { exit: false }
  if (["/exit", "/quit", "/q"].includes(normalized)) return { exit: true }

  if (["/help", "/h", "/?"].includes(normalized)) {
    print(help(providersConfigured))
    return { exit: false }
  }

  if (["/keys", "/k"].includes(normalized)) {
    print(shortcutLegend())
    return { exit: false }
  }

  if (["/session", "/s"].includes(normalized)) {
    print(`session=${state.sessionId}`)
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
    print(renderRuntimeDashboardView({
      theme: ctx.themeState.theme,
      ...runtimeView
    }))
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
    for (const line of renderInstalledCommandSurface({ customCommands, skills })) print(line)
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
    print("")
    for (const line of renderCapabilityPanel(capabilitySnapshot)) print(line)
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
    print(describeReloadSummary({ commandCount: reloaded.length, skillCount, agentCount }))
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
    print("workspace trusted")
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
    print("workspace trust revoked — project tools and extensions are now blocked")
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
        print(`compacted: ${result.summarizedCount} messages summarized, ${result.keptCount} kept`)
      } else {
        print(`skipped: ${result.reason}`)
      }
    } catch (err) {
      print(`compact failed: ${err.message}`)
    }
    return { exit: false }
  }

  if (["/new", "/n"].includes(normalized)) {
    state.sessionId = newSessionId()
    print(`new session: ${state.sessionId}`)
    return { exit: false }
  }

  if (["/history"].includes(normalized)) {
    const sessions = await listSessions({ cwd: process.cwd(), limit: 8, includeChildren: false })
    if (!sessions.length) print("no sessions found")
    else {
      for (const s of sessions) {
        const age = ageLabel(Date.now() - s.updatedAt)
        const title = s.title || `${s.mode}:${s.model || "?"}`
        const titleClipped = title.length > 35 ? title.slice(0, 32) + "..." : title
        print(`  ${s.id.slice(0, 12)}  ${padRight(titleClipped, 36)} ${padRight(s.mode, 9)} ${padRight(s.status || "-", 10)} ${age}`)
      }
    }
    return { exit: false }
  }

  if (normalized === "/resume" || normalized.startsWith("/resume ") || normalized === "/r" || normalized.startsWith("/r ")) {
    const arg = normalized.replace(/^\/(resume|r)/, "").trim()
    const sessions = await listSessions({ cwd: process.cwd(), limit: 20, includeChildren: false })

    if (!sessions.length) {
      print("no sessions found in current directory")
      return { exit: false }
    }

    let target = null

    if (!arg) {
      // Show interactive numbered list
      print(`\n  Sessions in ${paint(process.cwd(), "cyan")}:\n`)
      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i]
        const num = paint(`  ${String(i + 1).padStart(2)}.`, "yellow")
        const title = s.title || `${s.mode}:${s.model || "?"}`
        const titleClipped = title.length > 45 ? title.slice(0, 42) + "..." : title
        const age = ageLabel(Date.now() - s.updatedAt)
        const mode = paint(padRight(s.mode, 9), "cyan")
        const status = s.status === "active" ? paint("active", "green") : paint(s.status || "-", null, { dim: true })
        print(`${num} ${padRight(titleClipped, 46)} ${mode} ${padRight(status, 14)} ${paint(age, null, { dim: true })}`)
      }
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
      print(`no session matching "${arg}"`)
      return { exit: false }
    }

    state.sessionId = target.id
    state.mode = target.mode || state.mode
    state.providerType = target.providerType || state.providerType
    state.model = target.model || state.model
    const title = target.title || `${target.mode}:${target.model || "?"}`
    print(`resumed: ${paint(title, "cyan")} (${target.mode}, ${target.model || "?"})`)
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

  if (["/assistant", "/plan", "/agent", "/code", "/coding", "/longagent"].includes(normalized)) {
    state.mode = resolveMode(normalized.slice(1))
    if (normalized === "/longagent") state.longagentImpl = null
    print(`mode switched: ${state.mode}`)
    return { exit: false }
  }

  if (normalized.startsWith("/longagent ")) {
    const rawSub = normalized.replace("/longagent ", "").trim()
    const sub = rawSub.toLowerCase()
    if (sub === "4stage") {
      state.mode = "longagent"
      state.longagentImpl = "4stage"
      print("mode switched: longagent (4stage)")
    } else if (sub === "hybrid") {
      state.mode = "longagent"
      state.longagentImpl = "hybrid"
      print("mode switched: longagent (hybrid)")
    } else {
      state.mode = "longagent"
      state.longagentImpl = null
      normalized = rawSub
    }
    if (sub === "4stage" || sub === "hybrid") return { exit: false }
  }

  if (normalized.startsWith("/mode ") || normalized.startsWith("/m ")) {
    const next = resolveMode(normalized.replace(/^\/(mode|m)\s+/, "").trim())
    state.mode = next
    print(`mode switched: ${next}`)
    return { exit: false }
  }

  if (normalized === "/provider" || normalized === "/p") {
    if (wizard && setWizard) {
      startWizard(wizard, print)
      setWizard({ ...wizard })
    } else {
      print(`available providers: ${providersConfigured.join(", ")}`)
    }
    return { exit: false }
  }

  if (normalized.startsWith("/provider ") || normalized.startsWith("/p ")) {
    const rest = normalized.replace(/^\/(provider|p)\s+/, "").trim()

    // /provider edit <name> — 编辑已有 provider 配置
    if (rest.startsWith("edit ") || rest === "edit") {
      const editName = rest.replace(/^edit\s*/, "").trim()
      if (!editName) {
        print("usage: /provider edit <name>")
        return { exit: false }
      }
      const providerCfg = ctx.configState.config?.provider?.[editName]
      if (!providerCfg || typeof providerCfg !== "object") {
        print(`provider "${editName}" 未找到，可用: ${providersConfigured.join(", ")}`)
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
      print(`provider must be one of: ${providersConfigured.join(", ")}`)
      return { exit: false }
    }
    state.providerType = next
    state.model = resolveProviderDefaultModel(ctx.configState.config, next, state.model)
    print(`provider switched: ${next} (model: ${state.model})`)
    const catalog = await loadProviderModelItems(ctx.configState, next)
    if (catalog.items.length > 1) {
      print(`  可用模型 (${catalog.source}${catalog.stale ? ", stale" : ""}): ` + catalog.items.map(m => m.model).join(", "))
    }
    if (catalog.warning) print(`  模型目录提示: ${catalog.warning}`)
    if (catalog.error) print(`  模型目录不可用: ${catalog.error}；仍可使用 /model <model-id> 手动设置`)
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
    if (!next) print("usage: /model <model-id>")
    else {
      try {
        state.model = validateModelId(next)
        print(`model switched: ${escapeTerminalText(state.model)}`)
      } catch (error) {
        print(`invalid model id: ${escapeTerminalText(error.message)}`)
      }
    }
    return { exit: false }
  }

  if (normalized === "/permission" || normalized.startsWith("/permission ")) {
    const tokens = normalized.split(/\s+/).slice(1)
    const sub = (tokens[0] || "show").toLowerCase()
    const permission = ctx.configState.config.permission || (ctx.configState.config.permission = {})

    if (sub === "show") {
      print(`level: ${normalizePermissionLevel(permission)}`)
      print(`non_tty: ${permission.non_tty_default || "deny"}`)
      return { exit: false, openPolicyPicker: true }
    }

    if (sub === "list" || sub === "rules") {
      const all = Array.isArray(permission.rules) ? permission.rules : []
      const learned = listLearnedRules(all)
      const manual = all.filter((rule) => !isLearnedRule(rule))
      if (!all.length) {
        print("no permission rules configured")
        return { exit: false }
      }
      if (manual.length) {
        print(`configured rules (${manual.length}):`)
        for (const rule of manual) print(`  ${escapeTerminalText(describeRule(rule))}`)
      }
      if (learned.length) {
        print(`always-allow rules (${learned.length}) — /permission forget <n>:`)
        for (const [index, rule] of learned.entries()) {
          print(`  [${index}] ${escapeTerminalText(describeRule(rule))}`)
        }
      }
      return { exit: false }
    }

    if (sub === "forget") {
      const arg = String(tokens[1] || "").toLowerCase()
      const all = arg === "--learned" || arg === "all"
      if (!all && !/^\d+$/.test(arg)) {
        print("usage: /permission forget <n|all>")
        return { exit: false }
      }
      const outcome = removeLearnedRules(permission.rules, all ? { all: true } : { index: Number(arg) })
      if (!outcome.removed.length) {
        print("no matching always-allow rule")
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
        print(`forgot ${outcome.removed.length} always-allow rule(s) -> ${target}`)
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
        : `permission.level -> ${applied.level} (runtime, ${sub} 已合并为 ${applied.level})`)
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
        print("usage: /permission non-tty <allow_once|deny>")
        return { exit: false }
      }
      permission.non_tty_default = value
      print(`permission.non_tty_default -> ${value} (runtime)`)
      return { exit: false }
    }

    if (sub === "save") {
      const scope = String(tokens[1] || "project").toLowerCase()
      if (!["project", "user"].includes(scope)) {
        print("usage: /permission save [project|user]")
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
        print(`permission saved (${scope}) -> ${target}`)
      } catch (error) {
        print(`permission save failed: ${error.message}`)
      }
      return { exit: false }
    }

    if (sub === "session-clear" || sub === "reset") {
      PermissionEngine.clearSession(state.sessionId)
      print(`permission session cache cleared: ${state.sessionId}`)
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
      print(`image pasted from clipboard (${pendingImages.length} image(s) attached, send a message to include)`)
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
      print("usage: /create-skill <description of what the skill should do>")
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
        print("skill generation failed — no output from model")
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
      print(`skill /${skill.name} is now available`)
    } catch (error) {
      print(`skill generation error: ${error.message}`)
    }
    return { exit: false }
  }

  // /create-agent — AI generates a new sub-agent from description
  if (normalized === "/create-agent" || normalized.startsWith("/create-agent ")) {
    const description = normalized.replace(/^\/create-agent\s*/, "").trim()
    if (!description) {
      print("usage: /create-agent <description of what the agent should do>")
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
        print("agent generation failed — no output from model")
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
      print(`agent "${agent.name}" is now available as a sub-agent`)
    } catch (error) {
      print(`agent generation error: ${error.message}`)
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
        print(`unknown skill: $${name}`)
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
        print(`skill $${name} returned no output`)
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
        print(`unknown slash command: /${name}`)
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
      const stg = result.longagent.currentStageId
        ? result.longagent.currentStageId
        : `${(result.longagent.stageIndex || 0) + 1}/${Math.max(1, result.longagent.stageCount || 1)}`
      print(`longagent: phase=${result.longagent.phase || "-"} stage=${stg} gate=${result.longagent.currentGate || "-"}`)
      if (result.longagent.taskProgress && Object.keys(result.longagent.taskProgress).length) {
        for (const line of renderTaskProgressPanel(result.longagent.taskProgress, formatPlanProgress)) print(line)
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
  return {
    exit: false,
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

    const action = await processInputLine({
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
      print: (text) => console.log(text),
      pendingImages: linePendingImages,
      clearPendingImages: () => { linePendingImages = [] }
    })

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

function renderSuggestions({ inputLine, suggestions, selected, offset, maxVisible, theme, width }) {
  const sigil = String(inputLine || "").startsWith("$") ? "$" : String(inputLine || "").startsWith("/") ? "/" : null
  if (!sigil || !suggestions.length) {
    return { lines: [], offset: 0 }
  }
  const visible = Math.max(1, maxVisible || MAX_TUI_SUGGESTIONS)
  let start = Math.max(0, Math.min(offset || 0, Math.max(0, suggestions.length - visible)))
  if (selected < start) start = selected
  if (selected >= start + visible) start = selected - visible + 1

  const end = Math.min(suggestions.length, start + visible)
  const view = suggestions.slice(start, end)
  const lines = [
    paint(
      `${sigil === "$" ? "Skills" : "Slash Commands"} (${selected + 1}/${suggestions.length})  Enter choose, Enter again execute`,
      theme.base.muted,
      { bold: true }
    )
  ]
  for (let i = 0; i < view.length; i++) {
    const item = view[i]
    const index = start + i
    const active = index === selected
    const prefix = active ? ">" : " "
    const line = `${prefix} ${sigil}${padRight(item.name, 14)} ${item.desc}`
    lines.push(
      active
        ? paint(line, "#111111", { bg: theme.semantic.info, bold: true })
        : paint(line, theme.base.fg)
    )
  }
  if (suggestions.length > visible) {
    lines.push(
      paint(`scroll: ${start + 1}-${end}/${suggestions.length} (Up/Down)`, theme.base.muted)
    )
  }
  return {
    lines: lines.map((line) => clipAnsiLine(line, width)),
    offset: start
  }
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
    questionIndex: 0,
    questionOptionSelected: 0,
    questionMultiSelected: {},
    questionCustomMode: false,
    questionCustomInput: "",
    questionCustomCursor: 0,
    questionAnswers: {},
    modelPicker: null,
    policyPicker: null,
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
    inputLayout: null,
    // 屏幕布局元数据（buildFrame 中更新）
    layoutMeta: { logStartRow: 0, logEndRow: 0, inputStartRow: 0, inputEndRow: 0 },
    wizard: createWizardState(),
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

  function printTui(text = "") {
    const plain = stripAnsi(text).trim()
    if (/^(?:mode|model|provider|permission(?: level)?) switched:/i.test(plain)) {
      showToast(plain, { topic: "switch", tone: "success" })
      return null
    }
    if (/^dashboard refreshed$/i.test(plain)) {
      showToast(plain, { topic: "dashboard", tone: "success" })
      return null
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

  function openPolicyPicker() {
    const current = ctx.configState.config.permission || { mode: "auto" }
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
  }

  function insertAtCursor(text) {
    if (!text) return
    const head = ui.input.slice(0, ui.inputCursor)
    const tail = ui.input.slice(ui.inputCursor)
    ui.input = `${head}${text}${tail}`
    ui.inputCursor += text.length
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
  function extractPlainText(frameLines, row) {
    return copyableFrameLine(frameLines, row, {
      logStartRow: ui.layoutMeta.logStartRow,
      logEndRow: ui.layoutMeta.logEndRow,
      showScrollbar: ui.scrollMeta.totalRows > ui.scrollMeta.logRows
    })
  }

  // 对屏幕行数组应用选择高亮（反色）
  function applySelectionHighlight(frameLines, sel) {
    if (!sel) return
    const {
      startRow: r1,
      startCol: c1,
      endRow: r2,
      endCol: c2,
      isClick
    } = normalizeMouseSelection(sel)
    if (isClick) return

    for (let r = r1; r <= r2; r++) {
      if (r < 0 || r >= frameLines.length) continue
      const plain = stripAnsi(frameLines[r])
      const sc = r === r1 ? c1 : 0
      const ec = r === r2 ? c2 : displayWidth(plain)
      if (sc >= ec || sc >= displayWidth(plain)) continue

      const { before, selected, after } = splitTextByCellRange(plain, sc, ec)
      // \x1b[7m = 反色开始, \x1b[27m = 反色结束
      frameLines[r] = before + "\x1b[7m" + selected + "\x1b[27m" + after
    }
  }

  function buildFrame() {
    const width = Number(process.stdout.columns || 120)
    const height = Number(process.stdout.rows || 40)

    const dashboardLines = renderFrameDashboardHeader({
      showDashboard: ui.showDashboard,
      theme: ctx.themeState.theme,
      columns: width
    })

    const suggestions = slashSuggestions(ui.input, slashRouterOptions(localCustomCommands))
    if (suggestions.length === 0) {
      ui.selectedSuggestion = 0
      ui.suggestionOffset = 0
    } else if (ui.selectedSuggestion >= suggestions.length) {
      ui.selectedSuggestion = suggestions.length - 1
    }
    const suggestionRender = renderSuggestions({
      inputLine: ui.input,
      suggestions,
      selected: ui.selectedSuggestion,
      offset: ui.suggestionOffset,
      maxVisible: MAX_TUI_SUGGESTIONS,
      theme: ctx.themeState.theme,
      width: Math.max(1, width - 4)
    })
    const suggestionLines = suggestionRender.lines
    ui.suggestionOffset = suggestionRender.offset

    const status = renderReplStatusLine({
      state,
      configState: ctx.configState,
      theme: ctx.themeState.theme,
      tokenMeter: ui.metrics.tokenMeter,
      cost: ui.metrics.cost,
      costSavings: ui.metrics.costSavings,
      contextMeter: ui.metrics.context,
      longagentState: ui.metrics.longagent
    })

    const lines = []
    let dashboardRows = 0
    if (ui.showDashboard && dashboardLines.length) {
      dashboardRows = Math.min(dashboardLines.length, Math.max(5, Math.floor(height * 0.22)))
      lines.push(...dashboardLines.slice(0, dashboardRows).map((line) => clipAnsiLine(line, width)))
      lines.push(" ".repeat(width))
    }

    const inputInnerWidth = Math.max(8, width - 4)
    const imgTag = ui.pendingImages.length ? `[${ui.pendingImages.length} img] ` : ""
    const stateIndicator = ui.busy
      ? paint("● ", ctx.themeState.theme.semantic.warn)
      : ui.paused
        ? paint("⏸ ", ctx.themeState.theme.base.muted)
        : paint("❯ ", ctx.themeState.theme.semantic.success)
    const inputVisibleRows = Math.max(1, Math.min(5, Math.floor(height * 0.2)))
    const inputLayout = layoutInputText({
      value: ui.input,
      cursor: ui.inputCursor,
      width: inputInnerWidth,
      maxRows: inputVisibleRows,
      prefix: `${stateIndicator}${imgTag}`,
      selection: ui.inputSelection
    })
    ui.inputCursor = inputLayout.normalizedCursor
    ui.inputLayout = inputLayout
    const visibleInput = inputLayout.lines
    let busyLine
    if (ui.busy && ui.currentActivity) {
      const spinner = BUSY_SPINNER_FRAMES[ui.spinnerIndex]
      const stepTag = ui.currentStep > 0
        ? paint(` [${ui.currentStep}/${ui.maxSteps || "?"}]`, "cyan", { dim: true })
        : ""
      if (ui.currentActivity.type === "tool") {
        const toolName = ui.currentActivity.tool || "tool"
        const toolColor = toolName === "edit" || toolName === "write" || toolName === "notebookedit" ? "yellow"
          : toolName === "bash" ? "magenta"
          : "cyan"
        busyLine = `${paint(spinner, toolColor)} ${paint(toolName, toolColor, { bold: true })}${formatBusyToolDetail(toolName, ui.currentActivity.args)}${stepTag}`
      } else if (ui.currentActivity.type === "writing") {
        busyLine = `${paint(spinner, "green")} ${paint("writing", "green", { bold: true })}${stepTag}`
      } else {
        const elapsed = ui.thinking.startedAt
          ? formatThinkingDuration(Date.now() - ui.thinking.startedAt)
          : "0.0s"
        const dots = ".".repeat((ui.spinnerIndex % 3) + 1)
        busyLine = `${paint(spinner, ctx.themeState.theme.semantic.warn)} ${paint(`Thinking${dots} · ${elapsed}`, ctx.themeState.theme.semantic.warn, { bold: true })}${stepTag}`
      }
    } else if (ui.busy) {
      const spinner = BUSY_SPINNER_FRAMES[ui.spinnerIndex]
      const elapsed = ui.thinking.startedAt
        ? formatThinkingDuration(Date.now() - ui.thinking.startedAt)
        : "0.0s"
      const dots = ".".repeat((ui.spinnerIndex % 3) + 1)
      busyLine = `${paint(spinner, ctx.themeState.theme.semantic.warn)} ${paint(`Thinking${dots} · ${elapsed}`, ctx.themeState.theme.semantic.warn, { bold: true })}`
    } else {
      busyLine = ""
    }

    const suggestionBlock = suggestionLines.length ? suggestionLines.length + 1 : 0
    const PERM_CHOICES = PERMISSION_PROMPT_CHOICES
    const permissionLines = []
    if (ui.pendingPermission) {
      const perm = ui.pendingPermission
      const displayPerm = sanitizeTerminalValue({
        tool: perm.tool,
        command: perm.command,
        pattern: perm.pattern,
        risk: perm.risk,
        reason: perm.reason
      })
      const target = displayPerm.command ||
        (displayPerm.pattern && displayPerm.pattern !== "*" ? displayPerm.pattern : "")
      const toolInfo = `tool: ${displayPerm.tool}  risk: ${displayPerm.risk || 0}/10`
      const reasonInfo = displayPerm.reason ? `  ${displayPerm.reason}` : ""
      permissionLines.push(
        paint(`Permission Request  ↑↓ navigate  Enter select  Esc deny`, ctx.themeState.theme.semantic.warn, { bold: true })
      )
      permissionLines.push(paint(`┌${"─".repeat(Math.max(1, width - 4))}┐`, ctx.themeState.theme.base.border))
      permissionLines.push(paint(`│ ${padRight(toolInfo, Math.max(1, width - 5))}│`, ctx.themeState.theme.base.fg))
      if (target) {
        permissionLines.push(paint(`│ ${padRight(`target: ${target}`, Math.max(1, width - 5))}│`, ctx.themeState.theme.semantic.warn))
      }
      if (reasonInfo) {
        permissionLines.push(paint(`│ ${padRight(reasonInfo, Math.max(1, width - 5))}│`, ctx.themeState.theme.base.muted))
      }
      permissionLines.push(paint(`│${"─".repeat(Math.max(1, width - 4))}│`, ctx.themeState.theme.base.border))
      for (let i = 0; i < PERM_CHOICES.length; i++) {
        const choice = PERM_CHOICES[i]
        const active = i === ui.permissionSelected
        const prefix = active ? "▸" : " "
        const line = ` ${prefix} ${i + 1}. ${choice.label}`
        permissionLines.push(
          active
            ? paint(`│${padRight(line, Math.max(1, width - 5))}│`, "#111111", { bg: ctx.themeState.theme.semantic.warn, bold: true })
            : paint(`│${padRight(line, Math.max(1, width - 5))}│`, ctx.themeState.theme.base.fg)
        )
      }
      permissionLines.push(paint(`└${"─".repeat(Math.max(1, width - 4))}┘`, ctx.themeState.theme.base.border))
    }
    const modelPickerLines = []
    if (ui.modelPicker) {
      const mp = ui.modelPicker
      const visible = Math.min(mp.items.length, MAX_MODEL_PICKER_VISIBLE)
      let start = Math.max(0, Math.min(mp.offset, mp.items.length - visible))
      if (mp.selected < start) start = mp.selected
      if (mp.selected >= start + visible) start = mp.selected - visible + 1
      mp.offset = start
      const end = Math.min(mp.items.length, start + visible)
      modelPickerLines.push(
        paint(`Select Model (${mp.selected + 1}/${mp.items.length})  ↑↓ navigate  Enter select  Esc cancel`, ctx.themeState.theme.semantic.info, { bold: true })
      )
      modelPickerLines.push(paint(`┌${"─".repeat(Math.max(1, width - 4))}┐`, ctx.themeState.theme.base.border))
      for (let i = start; i < end; i++) {
        const item = mp.items[i]
        const active = i === mp.selected
        const current = item.model === state.model && item.provider === state.providerType
        const marker = current ? "●" : " "
        const prefix = active ? "▸" : " "
        const line = ` ${prefix} ${marker} ${item.label}`
        const padded = padRight(line, Math.max(1, width - 5))
        modelPickerLines.push(
          active
            ? paint(`│${padded}│`, "#111111", { bg: ctx.themeState.theme.semantic.info, bold: true })
            : paint(`│${padded}│`, current ? ctx.themeState.theme.semantic.success : ctx.themeState.theme.base.fg)
        )
      }
      modelPickerLines.push(paint(`└${"─".repeat(Math.max(1, width - 4))}┘`, ctx.themeState.theme.base.border))
      if (mp.items.length > visible) {
        modelPickerLines.push(paint(`  ${start + 1}-${end} of ${mp.items.length}`, ctx.themeState.theme.base.muted))
      }
    }
    const modelPickerBlock = modelPickerLines.length ? modelPickerLines.length : 0
    const policyPickerLines = []
    if (ui.policyPicker) {
      const currentPolicy = ctx.configState.config.permission?.level || ctx.configState.config.permission?.mode || ctx.configState.config.permission?.default_policy || "auto"
      policyPickerLines.push(
        paint(`Permission Policy  ↑↓ navigate  Enter select  Esc cancel`, ctx.themeState.theme.semantic.info, { bold: true })
      )
      policyPickerLines.push(paint(`┌${"─".repeat(Math.max(1, width - 4))}┐`, ctx.themeState.theme.base.border))
      for (let i = 0; i < POLICY_CHOICES.length; i++) {
        const choice = POLICY_CHOICES[i]
        const active = i === ui.policyPicker.selected
        const current = choice.value === currentPolicy
        const marker = current ? "●" : " "
        const prefix = active ? "▸" : " "
        policyPickerLines.push(
          active
            ? paint(`│${padRight(` ${prefix} ${marker} ${choice.label}  ${choice.desc}`, Math.max(1, width - 5))}│`, "#111111", { bg: ctx.themeState.theme.semantic.info, bold: true })
            : paint(`│${padRight(` ${prefix} ${marker} ${choice.label}`, 22)}${padRight(choice.desc, Math.max(1, width - 27))}│`, current ? ctx.themeState.theme.semantic.success : ctx.themeState.theme.base.fg)
        )
      }
      policyPickerLines.push(paint(`└${"─".repeat(Math.max(1, width - 4))}┘`, ctx.themeState.theme.base.border))
    }
    const policyPickerBlock = policyPickerLines.length
    const permissionBlock = permissionLines.length

    // --- Question panel ---
    const questionLines = []
    let questionCursor = null
    if (ui.pendingQuestion) {
      const pq = ui.pendingQuestion
      const questions = pq.questions || []
      const qCount = questions.length
      const currentQ = questions[ui.questionIndex] || {}
      const options = Array.isArray(currentQ.options) ? currentQ.options : []
      const answered = Object.keys(ui.questionAnswers).length

      // Header
      const hintKeys = ui.questionCustomMode
        ? "Enter confirm  Esc back"
        : "↑↓ select  Enter confirm  Tab switch  Esc skip  Ctrl+Enter submit all"
      questionLines.push(
        paint(`Question (${ui.questionIndex + 1}/${qCount})  ${hintKeys}`, ctx.themeState.theme.semantic.info, { bold: true })
      )
      questionLines.push(paint(`┌${"─".repeat(Math.max(1, width - 4))}┐`, ctx.themeState.theme.base.border))

      // Tab bar (multi-question)
      if (qCount > 1) {
        let tabBar = ""
        for (let i = 0; i < qCount; i++) {
          const qId = questions[i].id
          const done = qId in ui.questionAnswers
          const isCurrent = i === ui.questionIndex
          const marker = done ? "✓" : " "
          const tabLabel = (questions[i].header || `Q${i + 1}`).slice(0, 12)
          tabBar += isCurrent ? `[${marker}${tabLabel}]` : ` ${marker}${tabLabel} `
          if (i < qCount - 1) tabBar += " "
        }
        questionLines.push(paint(`│ ${padRight(tabBar, Math.max(1, width - 5))}│`, ctx.themeState.theme.base.fg))
        questionLines.push(paint(`│${"─".repeat(Math.max(1, width - 4))}│`, ctx.themeState.theme.base.border))
      }

      // Question text
      questionLines.push(paint(`│ ${padRight(currentQ.text || "", Math.max(1, width - 5))}│`, ctx.themeState.theme.base.fg))
      if (currentQ.description) {
        questionLines.push(paint(`│ ${padRight(currentQ.description, Math.max(1, width - 5))}│`, ctx.themeState.theme.base.muted))
      }
      questionLines.push(paint(`│${"─".repeat(Math.max(1, width - 4))}│`, ctx.themeState.theme.base.border))

      if (ui.questionCustomMode || options.length === 0) {
        // Custom/free-text mode uses the same grapheme-aware layout as the
        // main composer so the hardware cursor and IME stay anchored here.
        const questionInputLayout = layoutInputText({
          value: ui.questionCustomInput,
          cursor: ui.questionCustomCursor,
          width: Math.max(1, width - 5),
          maxRows: 3,
          prefix: ""
        })
        ui.questionCustomCursor = questionInputLayout.normalizedCursor
        questionLines.push(
          paint(`│ ${padRight(options.length ? "Custom input:" : "Answer:", Math.max(1, width - 5))}│`, ctx.themeState.theme.base.muted)
        )
        const questionInputStart = questionLines.length
        for (const [index, inputLine] of questionInputLayout.lines.entries()) {
          const visible = inputLine || (index === 0
            ? paint("(type your answer)", ctx.themeState.theme.base.muted, { dim: true })
            : "")
          questionLines.push(
            `│ ${padRight(visible, Math.max(1, width - 5))}│`
          )
        }
        questionCursor = {
          row: questionInputStart + questionInputLayout.cursor.row,
          col: 3 + questionInputLayout.cursor.col
        }
      } else if (options.length) {
        // Options list
        const multiSelected = ui.questionMultiSelected[currentQ.id] || new Set()
        for (let i = 0; i < options.length; i++) {
          const opt = options[i]
          const active = i === ui.questionOptionSelected
          const prefix = active ? "▸" : " "
          let marker
          if (currentQ.multi) {
            marker = multiSelected.has(i) ? "☑" : "☐"
          } else {
            marker = active ? "●" : "○"
          }
          const optLine = ` ${prefix} ${marker} ${opt.label}`
          questionLines.push(
            active
              ? paint(`│${padRight(optLine, Math.max(1, width - 5))}│`, "#111111", { bg: ctx.themeState.theme.semantic.info, bold: true })
              : paint(`│${padRight(optLine, Math.max(1, width - 5))}│`, ctx.themeState.theme.base.fg)
          )
          if (opt.description) {
            questionLines.push(paint(`│${padRight(`       ${opt.description}`, Math.max(1, width - 5))}│`, ctx.themeState.theme.base.muted))
          }
        }
        // Custom option
        if (currentQ.allowCustom !== false) {
          const customIdx = options.length
          const active = ui.questionOptionSelected === customIdx
          const prefix = active ? "▸" : " "
          const customLine = ` ${prefix}   Custom...`
          questionLines.push(
            active
              ? paint(`│${padRight(customLine, Math.max(1, width - 5))}│`, "#111111", { bg: ctx.themeState.theme.semantic.info, bold: true })
              : paint(`│${padRight(customLine, Math.max(1, width - 5))}│`, ctx.themeState.theme.base.muted)
          )
        }
      }

      // Footer
      questionLines.push(paint(`│${"─".repeat(Math.max(1, width - 4))}│`, ctx.themeState.theme.base.border))
      const multiCount = currentQ.multi ? (ui.questionMultiSelected[currentQ.id] || new Set()).size : 0
      const multiHint = currentQ.multi && multiCount > 0 ? `  (${multiCount} selected)` : ""
      const footerText = `Answered: ${answered}/${qCount}${multiHint}  [Ctrl+Enter submit all]`
      questionLines.push(paint(`│ ${padRight(footerText, Math.max(1, width - 5))}│`, ctx.themeState.theme.base.muted))
      questionLines.push(paint(`└${"─".repeat(Math.max(1, width - 4))}┘`, ctx.themeState.theme.base.border))
    }
    const questionBlock = questionLines.length

    const fixedRows =
      1 + // activity title
      1 + // scroll hint
      suggestionBlock +
      modelPickerBlock +
      policyPickerBlock +
      permissionBlock +
      questionBlock +
      1 + // status bar
      1 + // busy indicator
      1 + // input top border
      visibleInput.length +
      1 + // input bottom border
      1 // footer hint

    const logRows = Math.max(2, height - lines.length - fixedRows)
    const transcriptViewport = buildTranscriptViewport({
      logs: transcript.getItems(),
      width,
      logRows,
      scrollOffset: ui.scrollOffset,
      wrapLogLines,
      clipAnsiLine,
      paint,
      theme: ctx.themeState.theme
    })
    const wrappedLogs = transcriptViewport.wrappedLogs
    ui.scrollOffset = transcriptViewport.scrollOffset
    ui.scrollMeta = transcriptViewport.scrollMeta
    const scrollHint = transcriptViewport.scrollHint

    lines.push(clipAnsiLine(paint("─".repeat(Math.min(40, width)), ctx.themeState.theme.base.border, { dim: true }), width))

    // 记录日志区起始行号（0-based in lines array, 1-based on screen）
    const logStartRow = lines.length
    lines.push(...transcriptViewport.lines)

    const logEndRow = lines.length  // 日志区结束行号（不含）

    lines.push(clipAnsiLine(scrollHint, width))

    if (suggestionLines.length) {
      lines.push(clipAnsiLine(paint("Commands", ctx.themeState.theme.base.muted, { bold: true }), width))
      for (const line of suggestionLines) lines.push(clipAnsiLine(line, width))
    }

    if (modelPickerLines.length) {
      for (const line of modelPickerLines) lines.push(clipAnsiLine(line, width))
    }

    if (policyPickerLines.length) {
      for (const line of policyPickerLines) lines.push(clipAnsiLine(line, width))
    }

    if (permissionLines.length) {
      for (const line of permissionLines) lines.push(clipAnsiLine(line, width))
    }

    let questionStartRow = null
    if (questionLines.length) {
      questionStartRow = lines.length
      for (const line of questionLines) lines.push(clipAnsiLine(line, width))
    }

    lines.push(clipAnsiLine(status, width))
    lines.push(clipAnsiLine(renderToastLine() || busyLine, width))

    const inputTop = paint(`┌${"─".repeat(Math.max(1, width - 2))}┐`, ctx.themeState.theme.base.border)
    const inputBottom = paint(`└${"─".repeat(Math.max(1, width - 2))}┘`, ctx.themeState.theme.base.border)
    lines.push(inputTop)
    const inputStartRow = lines.length  // 输入区内容起始行
    for (const inputLine of visibleInput) {
      const left = paint("│ ", ctx.themeState.theme.base.border)
      const right = paint(" │", ctx.themeState.theme.base.border)
      lines.push(`${left}${clipAnsiLine(inputLine, inputInnerWidth)}${right}`)
    }
    const inputEndRow = lines.length  // 输入区内容结束行（不含）
    lines.push(inputBottom)
    lines.push(clipAnsiLine(paint("↵ send  ⌃J newline  ⌃Y auto-copy  /paste image  ? help", ctx.themeState.theme.base.muted, { dim: true }), width))

    // In very small terminals, preserve the composer and its real cursor by
    // trimming overflow from the top rather than cutting off the bottom pane.
    const frameStartRow = Math.max(0, lines.length - Math.max(1, height))
    const final = lines.slice(frameStartRow, frameStartRow + Math.max(1, height))
    while (final.length < height) final.push(" ".repeat(width))

    // 鼠标选择高亮：对选中区域应用反色
    if (ui.mouseSelection) {
      applySelectionHighlight(final, ui.mouseSelection)
    }

    // 存储布局元数据供鼠标事件使用（行号均为 1-based 屏幕坐标）
    ui.layoutMeta = {
      logStartRow: logStartRow + 1 - frameStartRow,
      logEndRow: logEndRow - frameStartRow,
      inputStartRow: inputStartRow + 1 - frameStartRow,
      inputEndRow: inputEndRow - frameStartRow,
      inputInnerOffset: 3,  // "│ " 占 2 个可见字符 + 1 (1-based)
      width,
      transcriptHitRegions: (transcriptViewport.hitRegions || []).map((region) => ({
        ...region,
        row: logStartRow + region.viewportRow + 1 - frameStartRow
      }))
    }

    const composerCursor = {
      row: inputStartRow + inputLayout.cursor.row + 1 - frameStartRow,
      col: Math.max(1, Math.min(width, 3 + inputLayout.cursor.col)),
      visible: true
    }
    const modalCursor = questionCursor && questionStartRow !== null
      ? {
          row: questionStartRow + questionCursor.row + 1 - frameStartRow,
          col: Math.max(1, Math.min(width, questionCursor.col)),
          visible: true
        }
      : null

    return {
      lines: final,
      width,
      height,
      wrappedLogs,
      cursor: modalCursor || composerCursor
    }
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

  async function submitCurrentInput() {
    const line = ui.input.replace(/\r/g, "")
    if (!line.trim() || ui.busy) return
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
        appendLog(paint("❯ ", ctx.themeState.theme.semantic.success) + paint(line, "#e2e8f0"))
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
          const action = await processInputLine({
            line: mergedPrompt,
            state, ctx, providersConfigured,
            customCommands: localCustomCommands,
            setCustomCommands: (next) => { localCustomCommands = next },
            wizard: ui.wizard,
            setWizard: (next) => { ui.wizard = next },
            print: printTui,
            streamSink: appendStreamChunk,
            showTurnStatus: false,
            pendingImages: ui.pendingImages,
            clearPendingImages: () => { ui.pendingImages = [] },
            signal: aborter.signal,
            suspendTui: withSuspendedTui
          })
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

    appendLog(paint("❯ ", ctx.themeState.theme.semantic.success) + paint(line, "#e2e8f0"))
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
      const action = await processInputLine({
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
        print: printTui,
        streamSink: appendStreamChunk,
        showTurnStatus: false,
        pendingImages: ui.pendingImages,
        clearPendingImages: () => { ui.pendingImages = [] },
        signal: aborter.signal,
        suspendTui: withSuspendedTui
      })

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
      if (action.openPolicyPicker) {
        openPolicyPicker()
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
  }

  function shouldApplySuggestionOnEnter() {
    return shouldApplySlashSuggestionOnEnter(
      ui.input,
      slashSuggestions(ui.input, slashRouterOptions(localCustomCommands)),
      ui.selectedSuggestion
    )
  }

  function cycleModeForwardAndNotify() {
    const next = nextMode(state.mode, MODE_CYCLE_ORDER)
    state.mode = next
    showToast(`Mode · ${next}`, { topic: "mode", tone: "success" })
    requestRender()
  }

  function cyclePermissionForwardAndNotify() {
    const permission = ctx.configState.config.permission || (ctx.configState.config.permission = {})
    const next = nextPermissionLevel(permission)
    ctx.configState.config.permission = applyPermissionLevel(next, permission)
    showToast(`Permission · ${next}`, { topic: "permission", tone: "success" })
    requestRender()
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
      // 点击日志区 → 开始文本选择
      ui.mouseSelection = {
        startRow: row, startCol: col,
        endRow: row, endCol: col,
        active: true,
        moved: false
      }
      return
    }

    // 左键拖拽 (button 32 = motion with left held)
    if (action === "primary-drag") {
      // 日志区拖拽
      if (ui.mouseSelection?.active) {
        ui.mouseSelection.endRow = row
        ui.mouseSelection.endCol = col
        if (row !== ui.mouseSelection.startRow || col !== ui.mouseSelection.startCol) {
          ui.mouseSelection.moved = true
        }
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
        ui.mouseSelection.endRow = row
        ui.mouseSelection.endCol = col
        if (row !== ui.mouseSelection.startRow || col !== ui.mouseSelection.startCol) {
          ui.mouseSelection.moved = true
        }
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
    return true
  }

  // 完成文本选择 → 根据 autoCopy 决定是否复制
  function finishSelection(forceCopy = false) {
    const sel = ui.mouseSelection
    if (!sel) return
    if (!_lastFrame?.lines) { ui.mouseSelection = null; return }

    const {
      startRow: r1,
      startCol: c1,
      endRow: r2,
      endCol: c2,
      isClick
    } = normalizeMouseSelection(sel)

    // 如果起止相同，视为单击而非选择
    if (isClick) {
      const hit = ui.layoutMeta.transcriptHitRegions?.find((region) =>
        region.row === r1 + 1 &&
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
      for (let r = r1; r <= r2; r++) {
        const plain = extractPlainText(_lastFrame.lines, r)
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
    textStreamBatcher.dispose()
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

      onResize = () => requestRender({ force: true })
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
          }
          ui.selectedSuggestion = 0
          ui.suggestionOffset = 0
          requestRender()
          return
        }

        if (key.name === "escape") {
          ui.input = ""
          ui.inputCursor = 0
          ui.selectedSuggestion = 0
          ui.suggestionOffset = 0
          requestRender()
          return
        }

        if (key.name === "tab") {
          if (key.shift) cyclePermissionForwardAndNotify()
          else applyCurrentSuggestion()
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

        if (key.ctrl && key.name === "e") {
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
    textStreamBatcher.dispose()
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
  void maybeNotifyUpdateOnStartup(ctx.configState.config, { currentVersion: PACKAGE_VERSION })
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

  splash.stop()

  PermissionEngine.setTrusted(ctx.trustState?.trusted !== false)
  if (!ctx.trustState?.trusted) {
    console.log(paint("  ⚠ workspace not trusted — tools are blocked. Run /trust to enable.", ctx.themeState.theme.semantic.warning))
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
