import { stdin as input, stdout as output } from "node:process"
import { createInterface } from "node:readline/promises"
import { emitKeypressEvents } from "node:readline"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { basename, dirname, join, resolve as resolvePath } from "node:path"
import YAML from "yaml"
import { buildContext, printContextWarnings } from "./context.mjs"
import { ensureEventSinks, executeTurn, newSessionId, resolveMode, routeMode } from "./session/engine.mjs"
import { summarizeRouteDecision } from "./session/engine.mjs"
import { buildAgentContinuationPrompt, summarizeAgentTransaction } from "./session/agent-transaction.mjs"
import {
  emitAgentContinuationInterrupted,
  emitAgentContinuationResumed,
  emitRouteDecisionEvent
} from "./session/routing-observability.mjs"
import { listProviders } from "./provider/router.mjs"
import { createWizardState, startWizard, startEditWizard, handleWizardInput, VENDOR_PRESETS } from "./provider/wizard.mjs"
import { loadCustomCommands, applyCommandTemplate } from "./command/custom-commands.mjs"
import { SkillRegistry } from "./skill/registry.mjs"
import { renderMarkdown, createStreamRenderer } from "./theme/markdown.mjs"
import { listSessions, getConversationHistory } from "./session/store.mjs"
import { compactSession } from "./session/compaction.mjs"
import { ToolRegistry } from "./tool/registry.mjs"
import { McpRegistry } from "./mcp/registry.mjs"
import { HookBus, initHookBus } from "./plugin/hook-bus.mjs"
import { BackgroundManager } from "./orchestration/background-manager.mjs"
import { renderReplDashboard, renderReplLogo, renderStartupHint } from "./ui/repl-dashboard.mjs"
import { buildHelpText, buildShortcutLegend } from "./ui/repl-help.mjs"
import { buildRouteFeedback } from "./ui/repl-route-feedback.mjs"
import { formatRuntimeStateText, normalizeDiagnostics, normalizeFileChanges, renderDiagnosticsLines, renderFileChangeLines } from "./ui/repl-turn-summary.mjs"
import { renderFrameDashboardHeader, renderReplStatusLine, renderRuntimeDashboardView, renderStartupScreen } from "./ui/repl-status-view.mjs"
import { paint } from "./theme/color.mjs"
import { PermissionEngine } from "./permission/engine.mjs"
import { setPermissionPromptHandler } from "./permission/prompt.mjs"
import { setQuestionPromptHandler } from "./tool/question-prompt.mjs"
import { createActivityRenderer, formatPlanProgress } from "./ui/activity-renderer.mjs"
import { EventBus } from "./core/events.mjs"
import { EVENT_TYPES } from "./core/constants.mjs"
import { extractImageRefs, buildContentBlocks, readClipboardImage, readClipboardText } from "./tool/image-util.mjs"
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
  { name: "mode", desc: "switch mode" },
  { name: "ask", desc: "switch to ask mode" },
  { name: "plan", desc: "switch to plan mode" },
  { name: "agent", desc: "switch to agent mode" },
  { name: "longagent", desc: "switch to longagent mode" },
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

function isFullWidthCodePoint(code) {
  if (Number.isNaN(code)) return false
  if (
    code >= 0x1100 && (
      code <= 0x115f ||
      code === 0x2329 || code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff) ||
      (code >= 0x20000 && code <= 0x3fffd)
    )
  ) return true
  return false
}

function displayWidth(text) {
  const raw = stripAnsi(text)
  let width = 0
  for (const ch of raw) {
    const code = ch.codePointAt(0)
    width += isFullWidthCodePoint(code) ? 2 : 1
  }
  return width
}

function clipPlainByWidth(text, maxWidth) {
  if (maxWidth <= 0) return ""
  let out = ""
  let used = 0
  for (const ch of String(text || "")) {
    const w = isFullWidthCodePoint(ch.codePointAt(0)) ? 2 : 1
    if (used + w > maxWidth) break
    out += ch
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
  if (width <= 1) return clipPlainByWidth(raw, Math.max(0, width))
  return `${clipPlainByWidth(raw, width - 1)}~`
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
    const parts = wrapPlainLine(line, width)
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

/**
 * 获取所有已配置 provider 的模型列表。
 * 优先使用 config 中的 models 数组，fallback 到 VENDOR_PRESETS。
 * 返回 [{ provider, model, label }]
 */
function allProviderModels(config) {
  const items = []
  const seen = new Set()
  for (const [name, conf] of Object.entries(config.provider || {})) {
    if (name === "default" || name === "strict_mode" || name === "model_context") continue
    if (!conf || typeof conf !== "object") continue
    // 模型列表：config > VENDOR_PRESETS
    const models = conf.models || VENDOR_PRESETS[name]?.models || []
    const defaultModel = conf.default_model || VENDOR_PRESETS[name]?.default_model
    // 如果连 models 和 default_model 都没有，跳过
    if (!models.length && !defaultModel) continue
    const modelList = models.length ? models : (defaultModel ? [defaultModel] : [])
    for (const model of modelList) {
      const key = `${name}/${model}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push({ provider: name, model, label: `${name} / ${model}` })
    }
  }
  return items
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

async function persistPermissionConfig({ scope, ctx, values }) {
  const source = ctx.configState?.source || {}
  const target = pickConfigPathForScope(scope, source, process.cwd())
  if (!target) throw new Error(`unable to resolve ${scope} config path`)

  let existing = {}
  try {
    const raw = await readFile(target, "utf8")
    existing = parseConfigByPath(target, raw) || {}
  } catch {
    existing = {}
  }

  const merged = mergeObject(existing, {
    permission: {
      default_policy: values.default_policy,
      non_tty_default: values.non_tty_default
    }
  })

  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, stringifyConfigByPath(target, merged), "utf8")

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

function collectMcpSummary() {
  const snapshot = McpRegistry.healthSnapshot()
  const tools = McpRegistry.listTools()
  const byServer = {}
  for (const tool of tools) {
    const server = tool.server || "unknown"
    byServer[server] = (byServer[server] || 0) + 1
  }
  const healthy = snapshot.filter((item) => item.ok).length
  return {
    configured: snapshot.length,
    healthy,
    unhealthy: snapshot.length - healthy,
    tools: tools.length,
    byServer,
    entries: snapshot
  }
}

function collectSkillSummary() {
  const list = SkillRegistry.isReady() ? SkillRegistry.list() : []
  return {
    total: list.length,
    template: list.filter((s) => s.type === "template").length,
    skillMd: list.filter((s) => s.type === "skill_md").length,
    mcpPrompt: list.filter((s) => s.type === "mcp_prompt").length,
    programmable: list.filter((s) => s.type === "mjs").length
  }
}

function buildSlashCatalog(customCommands = []) {
  const custom = customCommands.map((cmd) => ({
    name: cmd.name,
    desc: `custom (${cmd.scope || "project"})`
  }))
  const skills = SkillRegistry.isReady()
    ? SkillRegistry.list()
        .filter((s) => !custom.some((c) => c.name === s.name))
        .map((s) => ({ name: s.name, desc: `skill (${s.type})` }))
    : []
  return [...BUILTIN_SLASH, ...custom, ...skills]
}

function slashQuery(inputLine) {
  if (!String(inputLine || "").startsWith("/")) return null
  const raw = String(inputLine).slice(1)
  const firstSpace = raw.indexOf(" ")
  const token = (firstSpace >= 0 ? raw.slice(0, firstSpace) : raw).trim()
  return token
}

function slashSuggestions(inputLine, customCommands) {
  const token = slashQuery(inputLine)
  if (token === null) return []
  const all = buildSlashCatalog(customCommands)
  const q = token.toLowerCase()
  const ranked = all
    .map((item) => {
      const name = item.name.toLowerCase()
      let rank = 99
      if (!q) rank = 0
      else if (name === q) rank = 0
      else if (name.startsWith(q)) rank = 1
      else if (name.includes(q)) rank = 2
      return { ...item, rank }
    })
    .filter((item) => item.rank < 99)
    .sort((a, b) => (a.rank - b.rank) || a.name.localeCompare(b.name))

  return ranked
}

function applySuggestionToInput(current, suggestionName) {
  const raw = String(current || "")
  if (!raw.startsWith("/")) return raw
  const body = raw.slice(1)
  const firstSpace = body.indexOf(" ")
  if (firstSpace < 0) return `/${suggestionName} `
  return `/${suggestionName}${body.slice(firstSpace)}`
}

async function executePromptTurn({ prompt, state, ctx, streamSink = null, pendingImages = [], signal = null }) {
  // Detect image file references in the prompt
  const { text: cleanedPrompt, imagePaths, imageUrls = [] } = extractImageRefs(prompt, process.cwd())
  const effectivePrompt = cleanedPrompt ?? prompt
  let contentBlocks = null
  if (imagePaths.length || imageUrls.length || pendingImages.length) {
    contentBlocks = await buildContentBlocks(effectivePrompt, imagePaths, imageUrls)
    // buildContentBlocks returns plain string when no file images — normalize to array
    if (typeof contentBlocks === "string") {
      contentBlocks = [{ type: "text", text: contentBlocks }]
    }
    for (const img of pendingImages) {
      if (img && img.type === "image") contentBlocks.push(img)
    }
  }

  const chatParams = await HookBus.chatParams({
    prompt: effectivePrompt,
    mode: state.mode,
    model: state.model,
    providerType: state.providerType,
    sessionId: state.sessionId
  })

  const exec = async () => executeTurn({
    prompt: chatParams.prompt ?? effectivePrompt,
    contentBlocks,
    mode: chatParams.mode ?? state.mode,
    model: chatParams.model ?? state.model,
    sessionId: state.sessionId,
    configState: ctx.configState,
    providerType: chatParams.providerType ?? state.providerType,
    longagentImpl: state.longagentImpl ?? null,
    signal,
    output: streamSink && typeof streamSink === "function"
      ? { write: streamSink }
      : null
  })
  return { result: await exec() }
}

function normalizeSlashAlias(line) {
  if (line === "/h") return "/help"
  if (line === "/?") return "/help"
  if (line === "/n") return "/new"
  if (line === "/s") return "/session"
  if (line === "/k") return "/keys"
  if (line === "/r") return "/resume"
  if (line === "/m") return "/mode"
  if (line === "/p") return "/provider"
  if (line === "/q") return "/exit"
  return line
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
  const normalized = normalizeSlashAlias(String(line || "").trim())

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
    const latest = await listSessions({ cwd: process.cwd(), limit: 6, includeChildren: false }).catch(() => [])
    const mcpSummary = collectMcpSummary()
    const skillSummary = collectSkillSummary()
    const backgroundSummary = await BackgroundManager.summary().catch(() => null)
    print(renderRuntimeDashboardView({
      theme: ctx.themeState.theme,
      state,
      providers: providersConfigured,
      recentSessions: latest,
      mcpSummary,
      skillSummary,
      backgroundSummary,
      customCommandCount: customCommands.length,
      cwd: process.cwd()
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
    if (!customCommands.length && !skills.length) print("no custom commands or skills found")
    else {
      if (customCommands.length) {
        print("custom commands:")
        customCommands.forEach((cmd) => print(`  /${cmd.name} (${cmd.scope}) -> ${cmd.source}`))
      }
      const nonCustomSkills = skills.filter((s) => s.type !== "template")
      if (nonCustomSkills.length) {
        print("skills:")
        nonCustomSkills.forEach((s) => print(`  /${s.name} (${s.type}${s.scope ? ", " + s.scope : ""})`))
      }
    }
    return { exit: false }
  }

  if (["/reload"].includes(normalized)) {
    const reloaded = await loadCustomCommands(process.cwd())
    setCustomCommands(reloaded)
    await SkillRegistry.initialize(ctx.configState.config, process.cwd())
    const { CustomAgentRegistry } = await import("./agent/custom-agent-loader.mjs")
    await CustomAgentRegistry.initialize(process.cwd())
    const skillCount = SkillRegistry.isReady() ? SkillRegistry.list().length : 0
    const agentCount = CustomAgentRegistry.list().length
    print(`reloaded commands: ${reloaded.length}, skills: ${skillCount}, agents: ${agentCount}`)
    return { exit: false }
  }

  if (["/trust"].includes(normalized)) {
    await persistTrust(process.cwd())
    PermissionEngine.setTrusted(true)
    print("workspace trusted")
    return { exit: false }
  }
  if (["/untrust"].includes(normalized)) {
    await revokeTrust(process.cwd())
    PermissionEngine.setTrusted(false)
    print("workspace trust revoked — tools are now blocked")
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

  if (["/ask", "/plan", "/agent", "/longagent"].includes(normalized)) {
    state.mode = resolveMode(normalized.slice(1))
    if (normalized === "/longagent") state.longagentImpl = null
    print(`mode switched: ${state.mode}`)
    return { exit: false }
  }

  if (normalized.startsWith("/longagent ")) {
    const sub = normalized.replace("/longagent ", "").trim().toLowerCase()
    if (sub === "4stage") {
      state.mode = "longagent"
      state.longagentImpl = "4stage"
      print("mode switched: longagent (4stage)")
    } else if (sub === "hybrid") {
      state.mode = "longagent"
      state.longagentImpl = "hybrid"
      print("mode switched: longagent (hybrid)")
    } else {
      print("usage: /longagent [4stage|hybrid]")
    }
    return { exit: false }
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
    // 展示该 provider 下可用模型
    const providerModels = allProviderModels(ctx.configState.config).filter(m => m.provider === next)
    if (providerModels.length > 1) {
      print("  可用模型: " + providerModels.map(m => m.model).join(", "))
    }
    return { exit: false }
  }

  if (normalized === "/model") {
    print(`current: ${state.providerType} / ${state.model}`)
    const items = allProviderModels(ctx.configState.config)
    if (items.length) {
      print("")
      print("  可用模型：")
      for (const item of items) {
        const marker = (item.provider === state.providerType && item.model === state.model) ? " ●" : ""
        print(`    ${item.label}${marker}`)
      }
      print("")
      print("  用法: /model <model-id>  或  /provider <name> 切换厂商")
    }
    return { exit: false, openModelPicker: true }
  }

  if (normalized.startsWith("/model ")) {
    const next = normalized.replace("/model ", "").trim()
    if (!next) print("usage: /model <model-id>")
    else {
      state.model = next
      print(`model switched: ${next}`)
    }
    return { exit: false }
  }

  if (normalized === "/permission" || normalized.startsWith("/permission ")) {
    const tokens = normalized.split(/\s+/).slice(1)
    const sub = (tokens[0] || "show").toLowerCase()
    const permission = ctx.configState.config.permission || (ctx.configState.config.permission = {})

    if (sub === "show") {
      print(`current: ${permission.default_policy || "ask"}`)
      return { exit: false, openPolicyPicker: true }
    }

    if (["ask", "allow", "deny"].includes(sub)) {
      permission.default_policy = sub
      print(`permission.default_policy -> ${sub} (runtime)`)
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
            default_policy: permission.default_policy || "ask",
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

    print("usage: /permission [show|ask|allow|deny|non-tty <allow_once|deny>|save [project|user]|session-clear]")
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
      await SkillRegistry.initialize(ctx.configState.config, process.cwd())
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
      await CustomAgentRegistry.initialize(process.cwd())
      print(`agent "${agent.name}" is now available as a sub-agent`)
    } catch (error) {
      print(`agent generation error: ${error.message}`)
    }
    return { exit: false }
  }

  let prompt = normalized
  if (normalized.startsWith("/")) {
    const body = normalized.slice(1)
    const [name, ...argTokens] = body.split(/\s+/)
    const args = argTokens.join(" ").trim()

    // Try SkillRegistry first (covers templates, .mjs skills, MCP prompts)
    const skill = SkillRegistry.isReady() ? SkillRegistry.get(name) : null
    if (skill) {
      const expanded = await SkillRegistry.execute(name, args, {
        cwd: process.cwd(),
        mode: state.mode,
        model: state.model,
        provider: state.providerType,
        config: ctx.configState?.config || null
      })
      if (!expanded) {
        print(`skill /${name} returned no output`)
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
        for (const line of formatPlanProgress(result.longagent.taskProgress)) print(line)
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
      const latest = action.recentSessions || []
      const mcpSummary = collectMcpSummary()
      const skillSummary = collectSkillSummary()
      const backgroundSummary = await BackgroundManager.summary().catch(() => null)
      console.log(
        renderReplDashboard({
          theme: ctx.themeState.theme,
          state,
          providers: providersConfigured,
          recentSessions: latest,
          mcpSummary,
          skillSummary,
          backgroundSummary,
          customCommandCount: localCustomCommands.length,
          cwd: process.cwd()
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

function startTuiFrame() {
  output.write("\x1b[?1049h")
  output.write("\x1b[?25l")
  output.write("\x1b[?1002h")   // 启用鼠标按键+拖拽追踪（含滚轮）
  output.write("\x1b[?1006h")   // 启用 SGR 扩展模式
}

function stopTuiFrame() {
  output.write("\x1b[?1002l")   // 禁用鼠标追踪
  output.write("\x1b[?1006l")   // 禁用 SGR 模式
  output.write("\x1b[?25h")
  output.write("\x1b[?1049l")
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

function renderSuggestions({ inputLine, suggestions, selected, offset, maxVisible, theme, width }) {
  if (!String(inputLine || "").startsWith("/") || !suggestions.length) {
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
      `Slash Commands (${selected + 1}/${suggestions.length})  Enter choose, Enter again execute`,
      theme.base.muted,
      { bold: true }
    )
  ]
  for (let i = 0; i < view.length; i++) {
    const item = view[i]
    const index = start + i
    const active = index === selected
    const prefix = active ? ">" : " "
    const line = `${prefix} /${padRight(item.name, 14)} ${item.desc}`
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

  const ui = {
    input: "",
    inputCursor: 0,
    logs: [...mcpStatusLines],
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
    thinkingHidden: false,
    inThinkingStream: false,
    thinkingSkipped: false,
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
    autoCopy: false,       // 拖拽选择后是否自动复制到剪贴板（Ctrl+Y 切换）
    inputSelection: null,  // { start, end } 输入框内的选择范围（字符位置）
    inputDragAnchor: -1,   // 输入框拖拽起始字符位置
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
      cost: 0,
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

  function appendLog(text = "") {
    const follow = ui.scrollOffset === 0
    const lines = String(text || "").replace(/\r/g, "").split("\n")
    for (const line of lines) ui.logs.push(line)
    if (ui.logs.length > MAX_TUI_LOG_LINES) ui.logs.splice(0, ui.logs.length - MAX_TUI_LOG_LINES)
    if (follow) ui.scrollOffset = 0
  }

  // 流式 markdown 渲染器 — 每轮对话重置
  let _streamMd = createStreamRenderer()

  function resetStreamRenderer() {
    _streamMd = createStreamRenderer()
  }

  function appendStreamChunk(chunk = "") {
    // 如果 thinking 被隐藏且当前在 thinking 流中，跳过内容
    if (ui.thinkingHidden && ui.inThinkingStream) {
      ui.thinkingSkipped = true
      return
    }
    const mdEnabled = ctx.configState.config.ui?.markdown_render !== false
    const text = mdEnabled ? _streamMd.push(chunk) : String(chunk || "").replace(/\r/g, "")
    if (!text) return
    const follow = ui.scrollOffset === 0
    const parts = text.split("\n")
    if (!ui.logs.length) ui.logs.push("")
    ui.logs[ui.logs.length - 1] += parts[0]
    for (let i = 1; i < parts.length; i++) ui.logs.push(parts[i])
    if (ui.logs.length > MAX_TUI_LOG_LINES) ui.logs.splice(0, ui.logs.length - MAX_TUI_LOG_LINES)
    if (follow) ui.scrollOffset = 0
    requestRender()
  }

  function flushStreamRenderer() {
    const mdEnabled = ctx.configState.config.ui?.markdown_render !== false
    if (!mdEnabled) return
    const remaining = _streamMd.flush()
    if (remaining) appendLog(remaining)
    resetStreamRenderer()
  }

  const activityRenderer = createActivityRenderer({
    theme: ctx.themeState.theme,
    output: { appendLog, appendStreamChunk }
  })
  activityRenderer.start()

  const uiEventUnsub = EventBus.subscribe((event) => {
    const { type, payload } = event
    switch (type) {
      case EVENT_TYPES.TURN_STEP_START: {
        ui.currentStep = payload.step || 0
        ui.maxSteps = Number(ctx.configState.config.agent?.max_steps) || 25
        ui.currentActivity = { type: "thinking" }
        requestRender()
        break
      }
      case EVENT_TYPES.TOOL_START:
        ui.currentActivity = { type: "tool", tool: payload.tool, args: payload.args }
        requestRender()
        break
      case EVENT_TYPES.TOOL_FINISH:
      case EVENT_TYPES.TOOL_ERROR:
        ui.currentActivity = { type: "thinking" }
        requestRender()
        break
      case EVENT_TYPES.STREAM_TEXT_START:
        if (ui.inThinkingStream && ui.thinkingSkipped) {
          appendLog(paint("● Thinking (collapsed, Ctrl+T to expand)", null, { dim: true }))
          appendLog("")
        }
        ui.inThinkingStream = false
        ui.thinkingSkipped = false
        ui.currentActivity = { type: "writing" }
        requestRender()
        break
      case EVENT_TYPES.STREAM_THINKING_START:
        ui.inThinkingStream = true
        ui.thinkingSkipped = false
        ui.currentActivity = { type: "thinking" }
        requestRender()
        break
      case EVENT_TYPES.TURN_USAGE_UPDATE: {
        const u = payload.usage || {}
        ui.metrics.tokenMeter = {
          ...ui.metrics.tokenMeter,
          estimated: true,
          turn: { input: u.input || 0, output: u.output || 0 }
        }
        // rough cost estimate: opus-class rates with cache differentiation
        ui.metrics.cost = ((u.input || 0) * 15 + (u.output || 0) * 75 + (u.cacheRead || 0) * 1.5 + (u.cacheWrite || 0) * 18.75) / 1_000_000
        if (payload.context) ui.metrics.context = payload.context
        requestRender()
        break
      }
      case EVENT_TYPES.TURN_FINISH:
        flushStreamRenderer()
        if (ui.inThinkingStream && ui.thinkingSkipped) {
          appendLog(paint("● Thinking (collapsed, Ctrl+T to expand)", null, { dim: true }))
          appendLog("")
        }
        ui.inThinkingStream = false
        ui.thinkingSkipped = false
        ui.currentActivity = null
        ui.currentStep = 0
        requestRender()
        break
    }
  })

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
    if (!perm) return 0
    const da = perm.defaultAction
    if (da === "allow" || da === "allow_once") return 0
    if (da === "allow_session") return 1
    return 2
  }

  function queueQuestionPrompt(request) {
    ui.questionQueue.push(request)
    if (!ui.pendingQuestion) {
      activateNextQuestion()
    }
    requestRender({ force: true })
  }

  function activateNextQuestion() {
    if (ui.questionQueue.length === 0) {
      ui.pendingQuestion = null
      return
    }
    const next = ui.questionQueue.shift()
    ui.pendingQuestion = next
    ui.questionIndex = 0
    ui.questionOptionSelected = 0
    ui.questionMultiSelected = {}
    ui.questionCustomMode = false
    ui.questionCustomInput = ""
    ui.questionCustomCursor = 0
    ui.questionAnswers = {}
  }

  function commitCurrentQuestionAnswer() {
    if (!ui.pendingQuestion) return
    const questions = ui.pendingQuestion.questions || []
    const q = questions[ui.questionIndex]
    if (!q) return
    if (ui.questionCustomMode) {
      ui.questionAnswers[q.id] = ui.questionCustomInput || ""
      ui.questionCustomMode = false
      ui.questionCustomInput = ""
      ui.questionCustomCursor = 0
    } else if (q.multi) {
      const selected = ui.questionMultiSelected[q.id] || new Set()
      const values = [...selected].map((i) => {
        const opt = (q.options || [])[i]
        return opt ? (opt.value || opt.label) : ""
      }).filter(Boolean)
      ui.questionAnswers[q.id] = values.join(", ")
    } else {
      const opt = (q.options || [])[ui.questionOptionSelected]
      if (opt) {
        ui.questionAnswers[q.id] = opt.value || opt.label
      }
    }
  }

  function advanceOrSubmitQuestion() {
    commitCurrentQuestionAnswer()
    const questions = ui.pendingQuestion?.questions || []
    if (ui.questionIndex < questions.length - 1) {
      ui.questionIndex += 1
      ui.questionOptionSelected = 0
      ui.questionCustomMode = false
      ui.questionCustomInput = ""
      ui.questionCustomCursor = 0
      requestRender({ force: true })
    } else {
      resolveQuestionPrompt()
    }
  }

  function resolveQuestionPrompt() {
    if (!ui.pendingQuestion) return
    const current = ui.pendingQuestion
    const questions = current.questions || []
    // Ensure all unanswered questions get committed
    for (let i = 0; i < questions.length; i++) {
      if (!(questions[i].id in ui.questionAnswers)) {
        ui.questionAnswers[questions[i].id] = "(skipped)"
      }
    }
    const answers = { ...ui.questionAnswers }
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

  function buildModelPickerItems() {
    return allProviderModels(ctx.configState.config)
  }

  function openModelPicker() {
    const items = buildModelPickerItems()
    if (!items.length) {
      appendLog(paint("No models configured. Add `models` array to provider config.", ctx.themeState.theme.semantic.error))
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
      appendLog(paint(`model switched: ${chosen.provider} / ${chosen.model}`, ctx.themeState.theme.semantic.success))
    }
    closeModelPicker()
  }

  const POLICY_CHOICES = [
    { label: "Ask", value: "ask", desc: "prompt before each tool call" },
    { label: "Allow", value: "allow", desc: "allow all tool calls" },
    { label: "Deny", value: "deny", desc: "deny all tool calls" },
    { label: "Session Clear", value: "session-clear", desc: "clear cached grants" }
  ]

  function openPolicyPicker() {
    const current = ctx.configState.config.permission?.default_policy || "ask"
    const idx = POLICY_CHOICES.findIndex((c) => c.value === current)
    ui.policyPicker = { selected: Math.max(0, idx) }
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
      if (chosen.value === "session-clear") {
        PermissionEngine.clearSession(state.sessionId)
        appendLog(paint(`permission session cache cleared`, ctx.themeState.theme.semantic.success))
      } else {
        const permission = ctx.configState.config.permission || (ctx.configState.config.permission = {})
        permission.default_policy = chosen.value
        appendLog(paint(`permission policy → ${chosen.value}`, ctx.themeState.theme.semantic.success))
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
    ui.inputCursor = Math.max(0, Math.min(ui.input.length, ui.inputCursor + delta))
  }

  function setCursor(pos) {
    ui.inputCursor = Math.max(0, Math.min(ui.input.length, pos))
  }

  function scrollBy(delta) {
    const max = ui.scrollMeta.maxOffset || 0
    ui.scrollOffset = Math.max(0, Math.min(max, ui.scrollOffset + delta))
  }

  // SGR 鼠标事件解析：\x1b[<button;x;yM（按下）或 \x1b[<button;x;ym（释放）
  const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
  function parseSgrMouseEvents(data) {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data || "")
    const events = []
    let m
    while ((m = SGR_MOUSE_RE.exec(text)) !== null) {
      events.push({ button: parseInt(m[1], 10), x: parseInt(m[2], 10), y: parseInt(m[3], 10), release: m[4] === "m" })
    }
    SGR_MOUSE_RE.lastIndex = 0
    return events
  }

  function scrollToTop() {
    ui.scrollOffset = ui.scrollMeta.maxOffset || 0
  }

  function scrollToBottom() {
    ui.scrollOffset = 0
  }

  // OSC 52 剪贴板复制（终端原生支持，无需外部工具）
  function copyToClipboard(text) {
    if (!text) return
    const b64 = Buffer.from(text, "utf8").toString("base64")
    output.write(`\x1b]52;c;${b64}\x07`)
  }

  // 从渲染后的屏幕行中提取纯文本（用于选择复制）
  function extractPlainText(frameLines, row) {
    if (!frameLines || row < 0 || row >= frameLines.length) return ""
    return stripAnsi(frameLines[row])
  }

  // 对屏幕行数组应用选择高亮（反色）
  function applySelectionHighlight(frameLines, sel) {
    if (!sel) return
    let r1 = sel.startRow - 1, c1 = sel.startCol - 1
    let r2 = sel.endRow - 1, c2 = sel.endCol - 1
    if (r1 > r2 || (r1 === r2 && c1 > c2)) {
      ;[r1, c1, r2, c2] = [r2, c2, r1, c1]
    }
    if (r1 === r2 && c1 === c2) return

    for (let r = r1; r <= r2; r++) {
      if (r < 0 || r >= frameLines.length) continue
      const plain = stripAnsi(frameLines[r])
      const sc = r === r1 ? c1 : 0
      const ec = r === r2 ? c2 : plain.length
      if (sc >= ec || sc >= plain.length) continue

      const before = plain.slice(0, sc)
      const selected = plain.slice(sc, ec)
      const after = plain.slice(ec)
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

    const suggestions = slashSuggestions(ui.input, localCustomCommands)
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
    const cursorMark = "▌"
    const before = ui.input.slice(0, ui.inputCursor)
    const after = ui.input.slice(ui.inputCursor)
    const imgTag = ui.pendingImages.length ? `[${ui.pendingImages.length} img] ` : ""
    const stateIndicator = ui.busy
      ? paint("● ", ctx.themeState.theme.semantic.warn)
      : ui.paused
        ? paint("⏸ ", ctx.themeState.theme.base.muted)
        : paint("❯ ", ctx.themeState.theme.semantic.success)
    // 输入框选择高亮
    let inputBody
    const iSel = ui.inputSelection
    if (iSel && iSel.start < iSel.end) {
      const s = iSel.start, e = iSel.end, c = ui.inputCursor
      if (c <= s) {
        inputBody = ui.input.slice(0, c) + cursorMark + ui.input.slice(c, s) + "\x1b[7m" + ui.input.slice(s, e) + "\x1b[27m" + ui.input.slice(e)
      } else if (c >= e) {
        inputBody = ui.input.slice(0, s) + "\x1b[7m" + ui.input.slice(s, e) + "\x1b[27m" + ui.input.slice(e, c) + cursorMark + ui.input.slice(c)
      } else {
        inputBody = ui.input.slice(0, s) + "\x1b[7m" + ui.input.slice(s, c) + cursorMark + ui.input.slice(c, e) + "\x1b[27m" + ui.input.slice(e)
      }
    } else {
      inputBody = `${before}${cursorMark}${after}`
    }
    const inputDecorated = `${stateIndicator}${imgTag}${inputBody}`
    const inputLogical = inputDecorated.split("\n")
    const inputWrapped = []
    for (const logicalLine of inputLogical) {
      const wrapped = wrapPlainLine(logicalLine, inputInnerWidth)
      for (const part of wrapped) inputWrapped.push(part)
    }
    const inputVisibleRows = Math.max(1, Math.min(5, Math.floor(height * 0.2)))
    const visibleInput = inputWrapped.slice(-inputVisibleRows)
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
        busyLine = `${paint(spinner, ctx.themeState.theme.semantic.warn)} ${paint("thinking", ctx.themeState.theme.semantic.warn, { bold: true })}${stepTag}`
      }
    } else if (ui.busy) {
      const spinner = BUSY_SPINNER_FRAMES[ui.spinnerIndex]
      busyLine = `${paint(spinner, ctx.themeState.theme.semantic.warn)} ${paint("thinking", ctx.themeState.theme.semantic.warn, { bold: true })}`
    } else {
      busyLine = ""
    }

    const suggestionBlock = suggestionLines.length ? suggestionLines.length + 1 : 0
    const PERM_CHOICES = [
      { label: "Allow Once", value: "allow_once" },
      { label: "Allow Session", value: "allow_session" },
      { label: "Deny", value: "deny" }
    ]
    const permissionLines = []
    if (ui.pendingPermission) {
      const perm = ui.pendingPermission
      const toolInfo = `tool: ${perm.tool}`
      const reasonInfo = perm.reason ? `  ${perm.reason}` : ""
      permissionLines.push(
        paint(`Permission Request  ↑↓ navigate  Enter select  Esc deny`, ctx.themeState.theme.semantic.warn, { bold: true })
      )
      permissionLines.push(paint(`┌${"─".repeat(Math.max(1, width - 4))}┐`, ctx.themeState.theme.base.border))
      permissionLines.push(paint(`│ ${padRight(toolInfo, Math.max(1, width - 5))}│`, ctx.themeState.theme.base.fg))
      if (reasonInfo) {
        permissionLines.push(paint(`│ ${padRight(reasonInfo, Math.max(1, width - 5))}│`, ctx.themeState.theme.base.muted))
      }
      permissionLines.push(paint(`│${"─".repeat(Math.max(1, width - 4))}│`, ctx.themeState.theme.base.border))
      for (let i = 0; i < PERM_CHOICES.length; i++) {
        const choice = PERM_CHOICES[i]
        const active = i === ui.permissionSelected
        const prefix = active ? "▸" : " "
        const line = ` ${prefix} ${choice.label}`
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
      const currentPolicy = ctx.configState.config.permission?.default_policy || "ask"
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

      if (ui.questionCustomMode) {
        // Custom input mode
        const inputDisplay = ui.questionCustomInput || ""
        questionLines.push(
          paint(`│ ${padRight("Custom input:", Math.max(1, width - 5))}│`, ctx.themeState.theme.base.muted)
        )
        questionLines.push(
          paint(`│ ${padRight(inputDisplay || "(type your answer)", Math.max(1, width - 5))}│`, ctx.themeState.theme.base.fg)
        )
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
      } else {
        // No options — free text only
        const inputDisplay = ui.questionCustomInput || ""
        questionLines.push(
          paint(`│ ${padRight(inputDisplay || "(type your answer)", Math.max(1, width - 5))}│`, ctx.themeState.theme.base.fg)
        )
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
    const wrappedAllLogs = wrapLogLines(ui.logs, width)
    const maxOffset = Math.max(0, wrappedAllLogs.length - logRows)
    if (ui.scrollOffset > maxOffset) ui.scrollOffset = maxOffset
    const end = Math.max(0, wrappedAllLogs.length - ui.scrollOffset)
    const start = Math.max(0, end - logRows)
    const wrappedLogs = wrappedAllLogs.slice(start, end)
    ui.scrollMeta = {
      logRows,
      totalRows: wrappedAllLogs.length,
      maxOffset
    }

    const scrollHint = ui.scrollOffset > 0
      ? paint(`  Ctrl+Up/Down scroll | +${ui.scrollOffset} lines`, ctx.themeState.theme.semantic.warn)
      : paint("  Ctrl+Up/Down scroll | Ctrl+Home oldest | Ctrl+End latest", ctx.themeState.theme.base.muted, { dim: true })

    lines.push(clipAnsiLine(paint("─".repeat(Math.min(40, width)), ctx.themeState.theme.base.border, { dim: true }), width))

    // Scrollbar calculation
    const totalLog = wrappedAllLogs.length
    const showScrollbar = totalLog > logRows
    let thumbStart = 0, thumbEnd = 0
    if (showScrollbar) {
      const viewStart = start
      thumbStart = Math.floor((viewStart / totalLog) * logRows)
      thumbEnd = Math.min(logRows, thumbStart + Math.max(1, Math.round((logRows / totalLog) * logRows)))
    }

    // 记录日志区起始行号（0-based in lines array, 1-based on screen）
    const logStartRow = lines.length

    for (let i = 0; i < logRows; i++) {
      const content = wrappedLogs[i] || ""
      if (showScrollbar) {
        const bar = i >= thumbStart && i < thumbEnd
          ? paint("┃", ctx.themeState.theme.semantic.warn)
          : paint("│", ctx.themeState.theme.base.border, { dim: true })
        lines.push(clipAnsiLine(content, width - 2) + " " + bar)
      } else {
        lines.push(clipAnsiLine(content, width))
      }
    }

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

    if (questionLines.length) {
      for (const line of questionLines) lines.push(clipAnsiLine(line, width))
    }

    lines.push(clipAnsiLine(status, width))
    lines.push(clipAnsiLine(busyLine, width))

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

    const final = lines.slice(0, Math.max(1, height))
    while (final.length < height) final.push(" ".repeat(width))

    // 鼠标选择高亮：对选中区域应用反色
    if (ui.mouseSelection) {
      applySelectionHighlight(final, ui.mouseSelection)
    }

    // 存储布局元数据供鼠标事件使用（行号均为 1-based 屏幕坐标）
    ui.layoutMeta = {
      logStartRow: logStartRow + 1,
      logEndRow: logEndRow,
      inputStartRow: inputStartRow + 1,
      inputEndRow: inputEndRow,
      inputInnerOffset: 3,  // "│ " 占 2 个可见字符 + 1 (1-based)
      width
    }

    return { lines: final, width, height, wrappedLogs }
  }

  function paintFrame(frame) {
    if (!frame || !Array.isArray(frame.lines)) return
    _lastFrame = frame  // 保存帧数据供鼠标选择使用
    const patches = []

    if (forceFullPaint || frame.width !== lastFrameWidth || lastFrame.length !== frame.lines.length) {
      patches.push("\x1b[H")
      patches.push(frame.lines.join("\n"))
    } else {
      for (let i = 0; i < frame.lines.length; i++) {
        const next = frame.lines[i]
        const prev = lastFrame[i]
        if (next !== prev) patches.push(`\x1b[${i + 1};1H${next}`)
      }
    }

    if (patches.length) output.write(patches.join(""))
    lastFrame = frame.lines
    lastFrameWidth = frame.width
    forceFullPaint = false
  }

  function requestRender({ force = false } = {}) {
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
    if (ui.pendingModeConfirm && !line.startsWith("/")) {
      const confirm = ui.pendingModeConfirm
      ui.pendingModeConfirm = null
      const answer = line.trim().toLowerCase()
      const confirmed = ["y", "yes", "是", "继续", "ok", "好"].includes(answer)
      if (confirmed) {
        // 用户确认继续用 longagent，清除 abort 状态
        ui.longagentAborted = false
        appendLog(paint("继续使用 longagent 模式执行。", ctx.themeState.theme.semantic.info))
        ui.input = ""
        ui.inputCursor = 0
        requestRender()
        return
      } else {
        // 用户拒绝，切换到建议模式
        state.mode = confirm.suggestedMode
        appendLog(paint(`已切换到 ${confirm.suggestedMode} 模式。`, ctx.themeState.theme.semantic.success))
        ui.input = ""
        ui.inputCursor = 0
        requestRender()
        return
      }
    }

    if (ui.agentAborted && state.mode === "agent" && !line.startsWith("/")) {
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
    if (ui.longagentAborted && state.mode === "longagent" && !line.startsWith("/")) {
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
            print: appendLog,
            streamSink: appendStreamChunk,
            showTurnStatus: false,
            pendingImages: ui.pendingImages,
            clearPendingImages: () => { ui.pendingImages = [] },
            signal: aborter.signal,
            suspendTui: async (fn) => {
              stopBusySpinner()
              if (onKey) process.stdin.removeListener("keypress", onKey)
              if (onData) process.stdin.removeListener("data", onData)
              if (process.stdin.isTTY) process.stdin.setRawMode(false)
              stopTuiFrame()
              process.stdout.write("\x1b[2J\x1b[H")
              try { await fn() } finally {
                process.stdout.write("\x1b[2J\x1b[H")
                startTuiFrame()
                emitKeypressEvents(process.stdin)
                if (process.stdin.isTTY) process.stdin.setRawMode(true)
                process.stdin.resume()
                if (onKey) process.stdin.on("keypress", onKey)
                if (onData) process.stdin.on("data", onData)
                forceFullPaint = true
                requestRender()
              }
            }
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
          if (error.name !== "AbortError") appendLog(`error: ${error.message}`)
        } finally {
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

    if (ui.paused && ui.agentContinuation && state.mode === "agent" && !line.startsWith("/")) {
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
    if (!line.startsWith("/")) {
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
        appendLog(paint(routeFeedback.changedMessage, ctx.themeState.theme.semantic.info, { dim: true }))
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
        appendLog(paint(routeFeedback.suggestionMessage, ctx.themeState.theme.base.muted, { dim: true }))
      } else if (routeFeedback.stayedMessage) {
        appendLog(paint(routeFeedback.stayedMessage, ctx.themeState.theme.base.muted, { dim: true }))
      }
      if (routeFeedback.summaryMessage) {
        appendLog(paint(routeFeedback.summaryMessage, ctx.themeState.theme.base.muted, { dim: true }))
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
    if (state.mode === "longagent" && !line.startsWith("/")) {
      ui.lastLongAgentPrompt = submittedLine
      ui.longagentAborted = false
      ui.agentTransaction = null
      ui.agentAborted = false
    } else if (state.mode === "agent" && !line.startsWith("/")) {
      ui.agentTransaction = summarizeAgentTransaction({
        prompt: ui.agentTransaction?.objective || line,
        route,
        previous: ui.agentTransaction
      })
      ui.agentAborted = false
    } else if (!line.startsWith("/")) {
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
        print: appendLog,
        streamSink: appendStreamChunk,
        showTurnStatus: false,
        pendingImages: ui.pendingImages,
        clearPendingImages: () => { ui.pendingImages = [] },
        signal: aborter.signal,
        suspendTui: async (fn) => {
          stopBusySpinner()
          // Detach listeners before raw mode change to avoid ghost events
          if (onKey) process.stdin.removeListener("keypress", onKey)
          if (onData) process.stdin.removeListener("data", onData)
          if (process.stdin.isTTY) process.stdin.setRawMode(false)
          // Switch back to normal screen, then clear it
          stopTuiFrame()
          process.stdout.write("\x1b[2J\x1b[H")
          try {
            await fn()
          } finally {
            // Clear any onboarding remnants before switching back
            process.stdout.write("\x1b[2J\x1b[H")
            // Re-enter alternate screen and restore raw mode
            startTuiFrame()
            emitKeypressEvents(process.stdin)
            if (process.stdin.isTTY) process.stdin.setRawMode(true)
            process.stdin.resume()
            // Re-attach listeners
            if (onKey) process.stdin.on("keypress", onKey)
            if (onData) process.stdin.on("data", onData)
            forceFullPaint = true
            requestRender()
          }
        }
      })

      if (action.cleared) {
        ui.logs = []
      }
      if (action.dashboardRefresh) {
        localRecentSessions = action.recentSessions || localRecentSessions
        ui.showDashboard = true
        appendLog("dashboard refreshed")
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
        openModelPicker()
      }
      if (action.openPolicyPicker) {
        openPolicyPicker()
      }
      if (action.exit) {
        ui.quitting = true
      }
    } catch (error) {
      if (error.name !== "AbortError") appendLog(`error: ${error.message}`)
    } finally {
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
    const suggestions = slashSuggestions(ui.input, localCustomCommands)
    if (suggestions.length > 0 && String(ui.input || "").startsWith("/")) {
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
    const suggestions = slashSuggestions(ui.input, localCustomCommands)
    if (!suggestions.length) return
    const chosen = suggestions[Math.max(0, Math.min(ui.selectedSuggestion, suggestions.length - 1))]
    ui.input = applySuggestionToInput(ui.input, chosen.name)
    ui.inputCursor = ui.input.length
  }

  function shouldApplySuggestionOnEnter() {
    return shouldApplySlashSuggestionOnEnter(
      ui.input,
      slashSuggestions(ui.input, localCustomCommands),
      ui.selectedSuggestion
    )
  }

  function cycleModeForwardAndNotify() {
    const next = nextMode(state.mode, MODE_CYCLE_ORDER)
    state.mode = next
    appendLog(`mode switched: ${next}`)
    requestRender()
  }

  startTuiFrame()
  setPermissionPromptHandler(({ tool, sessionId, reason = "", defaultAction = "deny" }) =>
    new Promise((resolve) => {
      queuePermissionPrompt({
        tool,
        sessionId,
        reason,
        defaultAction,
        resolve
      })
    })
  )
  setQuestionPromptHandler(({ questions }) =>
    new Promise((resolve) => {
      queueQuestionPrompt({ questions, resolve })
    })
  )
  emitKeypressEvents(process.stdin)

  // Monkey-patch stdin.emit 拦截鼠标事件，防止 readline 将其解析为键盘输入
  let _lastFrame = null  // 保存最近一帧用于文本提取
  const _origStdinEmit = process.stdin.emit.bind(process.stdin)
  process.stdin.emit = function (event, ...args) {
    if (event === "data") {
      const raw = args[0]
      const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || "")
      if (SGR_MOUSE_RE.test(text)) {
        const mouseEvents = parseSgrMouseEvents(text)
        for (const ev of mouseEvents) {
          handleMouseEvent(ev)
        }
        if (mouseEvents.length > 0) requestRender()
        const cleaned = text.replace(SGR_MOUSE_RE, "")
        if (!cleaned) return false
        args[0] = Buffer.from(cleaned, "utf8")
      }
    }
    return _origStdinEmit(event, ...args)
  }

  function handleMouseEvent(ev) {
    const btn = ev.button
    // 滚轮
    if (btn === 64) { scrollBy(3); return }
    if (btn === 65) { scrollBy(-3); return }

    const row = ev.y  // 1-based 屏幕行
    const col = ev.x  // 1-based 屏幕列
    const layout = ui.layoutMeta

    // 左键按下 (button 0, press)
    if (btn === 0 && !ev.release) {
      // 清除之前的选择
      clearSelections()
      // 点击输入区 → 定位光标 + 准备拖拽
      if (row >= layout.inputStartRow && row < layout.inputEndRow) {
        handleInputClick(row, col, layout)
        return
      }
      // 点击日志区 → 开始文本选择
      ui.mouseSelection = {
        startRow: row, startCol: col,
        endRow: row, endCol: col,
        active: true
      }
      return
    }

    // 左键拖拽 (button 32 = motion with left held)
    if (btn === 32) {
      // 日志区拖拽
      if (ui.mouseSelection?.active) {
        ui.mouseSelection.endRow = row
        ui.mouseSelection.endCol = col
        return
      }
      // 输入框拖拽选择
      if (ui.inputDragAnchor >= 0 && row >= layout.inputStartRow && row < layout.inputEndRow) {
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
    if (btn === 0 && ev.release) {
      // 日志区选择完成
      if (ui.mouseSelection?.active) {
        ui.mouseSelection.endRow = row
        ui.mouseSelection.endCol = col
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
    const statePrefix = 2  // "❯ "
    const imgPrefix = ui.pendingImages.length ? `[${ui.pendingImages.length} img] `.length : 0
    const adjusted = Math.max(0, textCol - statePrefix - imgPrefix)
    return Math.min(adjusted, ui.input.length)
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
    if (ui.mouseSelection) { ui.mouseSelection = null }
    if (ui.inputSelection) { ui.inputSelection = null; ui.inputDragAnchor = -1 }
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
  function finishSelection() {
    const sel = ui.mouseSelection
    if (!sel) return
    if (!_lastFrame?.lines) { ui.mouseSelection = null; return }

    // 规范化选择范围（确保 start <= end）
    let r1 = sel.startRow - 1, c1 = sel.startCol - 1  // 转为 0-based
    let r2 = sel.endRow - 1, c2 = sel.endCol - 1
    if (r1 > r2 || (r1 === r2 && c1 > c2)) {
      ;[r1, c1, r2, c2] = [r2, c2, r1, c1]
    }

    // 如果起止相同，视为单击而非选择
    if (r1 === r2 && c1 === c2) {
      ui.mouseSelection = null
      return
    }

    // autoCopy 开启时提取文本并复制
    if (ui.autoCopy) {
      const lines = []
      for (let r = r1; r <= r2; r++) {
        const plain = extractPlainText(_lastFrame.lines, r)
        if (r === r1 && r === r2) {
          lines.push(plain.slice(c1, c2))
        } else if (r === r1) {
          lines.push(plain.slice(c1))
        } else if (r === r2) {
          lines.push(plain.slice(0, c2))
        } else {
          lines.push(plain)
        }
      }
      const selectedText = lines.join("\n").trimEnd()
      if (selectedText) copyToClipboard(selectedText)
      // 短暂保留高亮后清除
      setTimeout(() => {
        ui.mouseSelection = null
        requestRender()
      }, 200)
    }
    // autoCopy 关闭时：保留高亮，等待下次点击或按键清除
  }

  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.resume()

  paintFrame(buildFrame())

  let onResize = null
  let onKey = null
  let onData = null
  let onSigint = null
  try {
    await new Promise((resolve) => {
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        resolve()
      }

      onResize = () => requestRender({ force: true })
      onKey = async (str, key = {}) => {
        if (ui.quitting) return

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
            ui.quitting = true
            finish()
          } else {
            ui.lastCtrlCTime = now
            appendLog("Press Ctrl+C again to exit")
            requestRender()
          }
          return
        }

        if (key.ctrl && key.name === "d") {
          ui.quitting = true
          finish()
          return
        }

        if (ui.pendingPermission) {
          const PERM_VALUES = ["allow_once", "allow_session", "deny"]
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
                const before = ui.questionCustomInput.slice(0, ui.questionCustomCursor - 1)
                const after = ui.questionCustomInput.slice(ui.questionCustomCursor)
                ui.questionCustomInput = before + after
                ui.questionCustomCursor -= 1
              }
              requestRender()
              return
            }
            if (key.name === "left") {
              ui.questionCustomCursor = Math.max(0, ui.questionCustomCursor - 1)
              requestRender()
              return
            }
            if (key.name === "right") {
              ui.questionCustomCursor = Math.min(ui.questionCustomInput.length, ui.questionCustomCursor + 1)
              requestRender()
              return
            }
            // Printable character
            if (str && !key.ctrl && !key.meta && str.length === 1 && str.charCodeAt(0) >= 32) {
              const before = ui.questionCustomInput.slice(0, ui.questionCustomCursor)
              const after = ui.questionCustomInput.slice(ui.questionCustomCursor)
              ui.questionCustomInput = before + str + after
              ui.questionCustomCursor += 1
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
          appendLog("reading clipboard...")
          requestRender()
          const clipBlock = await readClipboardImage({
            onStatus: (msg) => {
              if (msg) {
                // Update the last log line with status
                if (ui.logs.length && ui.logs[ui.logs.length - 1].startsWith("reading clipboard") || ui.logs[ui.logs.length - 1].startsWith("processing image")) {
                  ui.logs[ui.logs.length - 1] = msg
                }
              }
              requestRender()
            }
          })
          // Remove status line
          if (ui.logs.length && (ui.logs[ui.logs.length - 1].startsWith("reading clipboard") || ui.logs[ui.logs.length - 1].startsWith("processing image"))) {
            ui.logs.pop()
          }
          if (clipBlock && clipBlock.type === "image") {
            ui.pendingImages.push(clipBlock)
            appendLog(`image pasted (${ui.pendingImages.length} attached)`)
            requestRender()
            return
          }
          if (clipBlock && clipBlock.type === "error") {
            appendLog(`paste failed: ${clipBlock.message}`)
            requestRender()
            return
          }
          // No image — try text clipboard
          const clipText = await readClipboardText()
          if (clipText) {
            insertAtCursor(clipText)
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
            const head = ui.input.slice(0, ui.inputCursor - 1)
            const tail = ui.input.slice(ui.inputCursor)
            ui.input = `${head}${tail}`
            ui.inputCursor -= 1
          }
          ui.selectedSuggestion = 0
          ui.suggestionOffset = 0
          requestRender()
          return
        }

        if (key.name === "delete") {
          if (!deleteInputSelection()) {
            const head = ui.input.slice(0, ui.inputCursor)
            const tail = ui.input.slice(ui.inputCursor + 1)
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
          cycleModeForwardAndNotify()
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
          ui.thinkingHidden = !ui.thinkingHidden
          appendLog(paint(`● Thinking ${ui.thinkingHidden ? "hidden" : "visible"} (Ctrl+T to toggle)`, null, { dim: true }))
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
          appendLog(paint(`● Auto-copy ${ui.autoCopy ? "ON" : "OFF"} (Ctrl+Y to toggle)`, null, { dim: true }))
          requestRender()
          return
        }

        if (key.ctrl && key.name === "l" && !key.shift) {
          ui.logs = []
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
          ui.quitting = true
          finish()
        } else {
          ui.lastCtrlCTime = now
          appendLog("Press Ctrl+C again to exit")
          requestRender()
        }
      }

      process.stdout.on("resize", onResize)
      process.stdin.on("keypress", onKey)
      process.stdin.on("data", onData)
      process.on("SIGINT", onSigint)
    })
  } finally {
    if (renderTimer) clearTimeout(renderTimer)
    stopBusySpinner()
    activityRenderer.stop()
    uiEventUnsub()
    setPermissionPromptHandler(null)
    setQuestionPromptHandler(null)
    if (onResize) process.stdout.removeListener("resize", onResize)
    if (onKey) process.stdin.removeListener("keypress", onKey)
    if (onData) process.stdin.removeListener("data", onData)
    if (onSigint) process.removeListener("SIGINT", onSigint)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.emit = _origStdinEmit  // 还原 stdin.emit
    stopTuiFrame()
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

  const splash = startSplash({ version: "v0.1.28" })

  const ctx = await buildContext({ trust, trustState })
  printContextWarnings(ctx)

  splash.update("loading tools & MCP servers...")
  await ToolRegistry.initialize({ config: ctx.configState.config, cwd: process.cwd() })

  // Collect MCP status for later display
  const mcpHealth = McpRegistry.healthSnapshot()
  const mcpStatusLines = collectMcpStatusLines(ctx.themeState.theme, mcpHealth, McpRegistry.listTools())

  splash.update("loading skills & agents...")
  await SkillRegistry.initialize(ctx.configState.config, process.cwd())
  const { CustomAgentRegistry } = await import("./agent/custom-agent-loader.mjs")
  await CustomAgentRegistry.initialize(process.cwd())

  splash.update("loading hooks & history...")
  await initHookBus()
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

  const customCommands = await loadCustomCommands(process.cwd())
  const providersConfigured = configuredProviders(ctx.configState.config, listProviders)
  const recentSessions = await listSessions({ cwd: process.cwd(), limit: 6, includeChildren: false }).catch(() => [])

  splash.stop()

  PermissionEngine.setTrusted(ctx.trustState?.trusted !== false)
  if (!ctx.trustState?.trusted) {
    console.log(paint("  ⚠ workspace not trusted — tools are blocked. Run /trust to enable.", ctx.themeState.theme.semantic.warning))
  }

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
}
