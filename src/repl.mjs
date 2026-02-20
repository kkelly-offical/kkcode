import { stdin as input, stdout as output } from "node:process"
import { createInterface } from "node:readline/promises"
import { emitKeypressEvents } from "node:readline"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import YAML from "yaml"
import { buildContext, printContextWarnings } from "./context.mjs"
import { executeTurn, newSessionId, resolveMode } from "./session/engine.mjs"
import { renderStatusBar } from "./theme/status-bar.mjs"
import { listProviders } from "./provider/router.mjs"
import { loadCustomCommands, applyCommandTemplate } from "./command/custom-commands.mjs"
import { SkillRegistry } from "./skill/registry.mjs"
import { renderMarkdown } from "./theme/markdown.mjs"
import { listSessions, getConversationHistory } from "./session/store.mjs"
import { ToolRegistry } from "./tool/registry.mjs"
import { McpRegistry } from "./mcp/registry.mjs"
import { HookBus, initHookBus } from "./plugin/hook-bus.mjs"
import { renderReplDashboard, renderReplLogo, renderStartupHint } from "./ui/repl-dashboard.mjs"
import { paint } from "./theme/color.mjs"
import { PermissionEngine } from "./permission/engine.mjs"
import { setPermissionPromptHandler } from "./permission/prompt.mjs"
import { setQuestionPromptHandler } from "./tool/question-prompt.mjs"
import { createActivityRenderer, formatPlanProgress } from "./ui/activity-renderer.mjs"
import { EventBus } from "./core/events.mjs"
import { EVENT_TYPES } from "./core/constants.mjs"
import { extractImageRefs, buildContentBlocks, readClipboardImage, readClipboardText } from "./tool/image-util.mjs"
import { generateSkill, saveSkillGlobal } from "./skill/generator.mjs"
import { userConfigCandidates, projectConfigCandidates, memoryFilePath } from "./storage/paths.mjs"
import { persistTrust, revokeTrust } from "./permission/workspace-trust.mjs"

const HIST_DIR = join(homedir(), ".kkcode")
const HIST_FILE = join(HIST_DIR, "repl_history")
const HIST_SIZE = 500
const MAX_TUI_LOG_LINES = 1200
const MAX_TUI_SUGGESTIONS = 5
const MAX_MODEL_PICKER_VISIBLE = 8
const TUI_FRAME_MS = 16
const ANSI_RE = /\x1B\[[0-9;]*m/g
const SCROLL_PAGE_RATIO = 0.75
const MODE_CYCLE_ORDER = ["longagent", "plan", "ask", "agent"]
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
  { name: "mode", desc: "switch mode" },
  { name: "provider", desc: "switch provider" },
  { name: "model", desc: "open model picker" },
  { name: "permission", desc: "permission policy / cache" },
  { name: "status", desc: "runtime state" },
  { name: "commands", desc: "list custom slash commands" },
  { name: "reload", desc: "reload custom commands" },
  { name: "paste", desc: "paste image from clipboard" },
  { name: "keys", desc: "show key map" },
  { name: "session", desc: "show session id" },
  { name: "ask", desc: "switch to ask mode" },
  { name: "plan", desc: "switch to plan mode" },
  { name: "agent", desc: "switch to agent mode" },
  { name: "longagent", desc: "switch to longagent mode" },
  { name: "create-skill", desc: "generate a new skill via AI" },
  { name: "create-agent", desc: "generate a new sub-agent via AI" },
  { name: "trust", desc: "trust this workspace" },
  { name: "untrust", desc: "revoke workspace trust" },
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

function configuredProviders(config) {
  const builtins = new Set(listProviders())
  const out = []
  for (const [name, value] of Object.entries(config.provider || {})) {
    if (name === "default") continue
    if (!value || typeof value !== "object") continue
    const type = value.type || name
    if (builtins.has(type)) out.push(name)
  }
  return out
}

async function loadHistory() {
  try {
    const raw = await readFile(HIST_FILE, "utf8")
    return raw.split("\n").filter(Boolean).slice(-HIST_SIZE)
  } catch {
    return []
  }
}

async function saveHistoryLines(lines) {
  try {
    await mkdir(HIST_DIR, { recursive: true })
    const finalLines = [...lines].slice(-HIST_SIZE)
    await writeFile(HIST_FILE, finalLines.join("\n") + (finalLines.length ? "\n" : ""), "utf8")
  } catch {}
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

function clearScreen() {
  if (!process.stdout.isTTY) return
  process.stdout.write("\x1Bc")
}

function help(providers = []) {
  const rows = [
    ["/help,/h,/?", "show help"],
    ["/dash,/home", "show dashboard panel"],
    ["/clear,/cls", "clear terminal"],
    ["/new,/n", "start a new session"],
    ["/resume [id],/r [id]", "resume a previous session"],
    ["/history", "list recent sessions"],
    ["/mode <name>,/m <name>", "switch mode (ask|plan|agent|longagent)"],
    ["/provider <type>,/p <type>", `switch provider (${providers.join("|") || "configured providers"})`],
    ["/model <id>", "set active model in current provider"],
    ["/permission [...]", "adjust permission policy"],
    ["/paste [text]", "paste clipboard image (with optional prompt)"],
    ["/session,/s", "print current session id"],
    ["/commands", "list custom slash commands"],
    ["/create-skill <desc>", "generate a new skill via AI"],
    ["/create-agent <desc>", "generate a new sub-agent via AI"],
    ["/reload", "reload commands, skills, agents"],
    ["/keys,/k", "show key map"],
    ["/status", "show current runtime state"],
    ["/exit,/quit,/q", "quit"],
    ["/ask /plan /agent /longagent", "quick mode switch"]
  ]
  const lines = ["", "Commands:"]
  for (const row of rows) lines.push(`  ${padRight(row[0], 28)} ${row[1]}`)

  lines.push("")
  lines.push("Configuration:")
  lines.push("  Global config     ~/.kkcode/config.yaml")
  lines.push("  Project config    kkcode.config.yaml / .kkcode/config.yaml")
  lines.push("  Custom commands   .kkcode/commands/    (project-level slash commands)")
  lines.push("  Custom skills     ~/.kkcode/skills/    or .kkcode/skills/")
  lines.push("  Custom agents     ~/.kkcode/agents/    or .kkcode/agents/")
  lines.push("  Custom tools      .kkcode/tools/       (project-level tool definitions)")
  lines.push("  Plugins/hooks     .kkcode/plugins/     (project-level hook scripts)")
  lines.push("  Rules             .kkcode/rules/       (project-level prompt rules)")
  lines.push("  Instructions      .kkcode/instructions.md or KKCODE.md")
  lines.push("  MCP servers       config.* -> mcp.servers")
  lines.push("")
  lines.push("Key config settings:")
  lines.push("  provider.default              default provider name")
  lines.push("  provider.<name>.api_key_env   env var for API key")
  lines.push("  provider.<name>.default_model default model id")
  lines.push("  agent.default_mode            startup mode (ask|plan|agent|longagent)")
  lines.push("  agent.longagent.git.enabled   git branch mgmt (true|false|\"ask\")")
  lines.push("  agent.longagent.usability_gates  quality gates config")
  lines.push("  permission.default_policy     tool permission (ask|allow|deny)")
  lines.push("  usage.budget.session_usd      per-session cost limit")
  lines.push("")
  lines.push("See notice.md in project root for full configuration guide.")
  return lines.join("\n")
}

function shortcutLegend() {
  return [
    "",
    "Shortcut Map:",
    "  /h      Help",
    "  /n      New session",
    "  /r      Resume latest session",
    "  /m      Switch mode",
    "  /p      Switch provider",
    "  /k      Show this key map",
    "  /permission [show|ask|allow|deny|non-tty <allow_once|deny>|save [project|user]|session-clear]",
    "  /dash   Redraw dashboard",
    "  /clear  Clear screen",
    "  /ask /plan /agent /longagent  Quick mode switch",
    "",
    "TUI keys:",
    "  Enter choose slash suggestion / submit prompt",
    "  Shift+Enter (or Ctrl+J) insert newline",
    "  Ctrl+V paste image from clipboard",
    "  Up/Down navigate suggestion/history",
    "  Left/Right/Home/End edit cursor",
    "  PgUp/PgDn scroll context history",
    "  Tab cycle mode (longagent -> plan -> ask -> agent)",
    "  Esc clear input  Ctrl+C exit"
  ].join("\n")
}

function runtimeStateText(state) {
  return [
    `session=${state.sessionId}`,
    `mode=${state.mode}`,
    `provider=${state.providerType}`,
    `model=${state.model}`
  ].join("\n")
}

function normalizeFileChanges(toolEvents = []) {
  const rows = []
  for (const event of toolEvents || []) {
    if (!event || !["write", "edit"].includes(event.name)) continue
    const changes = Array.isArray(event?.metadata?.fileChanges) ? event.metadata.fileChanges : []
    for (const item of changes) {
      const path = String(item?.path || event.args?.path || "").trim()
      if (!path) continue
      rows.push({
        path,
        addedLines: Number(item?.addedLines || 0),
        removedLines: Number(item?.removedLines || 0),
        stageId: item?.stageId ? String(item.stageId) : "",
        taskId: item?.taskId ? String(item.taskId) : ""
      })
    }
  }

  const grouped = new Map()
  for (const row of rows) {
    const key = `${row.path}::${row.stageId}::${row.taskId}`
    const prev = grouped.get(key) || {
      path: row.path,
      addedLines: 0,
      removedLines: 0,
      stageId: row.stageId,
      taskId: row.taskId
    }
    prev.addedLines += row.addedLines
    prev.removedLines += row.removedLines
    grouped.set(key, prev)
  }
  return [...grouped.values()]
}

function renderFileChangeLines(fileChanges = [], limit = 20) {
  const lines = []
  const rows = fileChanges.slice(0, limit)
  for (const item of rows) {
    const scope = [item.stageId, item.taskId].filter(Boolean).join("/")
    const suffix = scope ? paint(` (${scope})`, null, { dim: true }) : ""
    const add = item.addedLines > 0 ? paint(`+${item.addedLines}`, "green") : paint("+0", null, { dim: true })
    const del = item.removedLines > 0 ? paint(`-${item.removedLines}`, "red") : paint("-0", null, { dim: true })
    lines.push(`  ${paint(item.path, "white")}  ${add} ${del}${suffix}`)
  }
  if (fileChanges.length > rows.length) {
    lines.push(paint(`  ... +${fileChanges.length - rows.length} more file(s)`, null, { dim: true }))
  }
  return lines
}

function resolveProviderDefaultModel(config, providerType, fallback = "") {
  return (
    config.provider?.[providerType]?.default_model ||
    config.provider?.[config.provider?.default]?.default_model ||
    fallback
  )
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

function cycleMode(state) {
  const idx = MODE_CYCLE_ORDER.indexOf(state.mode)
  const nextIdx = idx >= 0 ? (idx + 1) % MODE_CYCLE_ORDER.length : 0
  state.mode = MODE_CYCLE_ORDER[nextIdx]
  return state.mode
}

/**
 * Collect single-line or multi-line input from the user.
 * - `"""` block mode: starts with `"""`, collects until a line is exactly `"""`
 * - `\` continuation: line ending with `\` continues on next line
 * - Otherwise: single line
 */
export async function collectInput(rl, promptStr) {
  const first = (await rl.question(promptStr)).trim()
  if (!first) return ""

  if (first === '"""' || first.startsWith('"""')) {
    const lines = []
    if (first !== '"""') lines.push(first.slice(3))
    while (true) {
      const next = await rl.question("... ")
      if (next.trim() === '"""') break
      lines.push(next)
    }
    return lines.join("\n").trim()
  }

  if (first.endsWith("\\")) {
    const lines = [first.slice(0, -1)]
    while (true) {
      const next = await rl.question("... ")
      if (next.endsWith("\\")) lines.push(next.slice(0, -1))
      else {
        lines.push(next)
        break
      }
    }
    return lines.join("\n").trim()
  }

  return first
}

async function executePromptTurn({ prompt, state, ctx, streamSink = null, pendingImages = [] }) {
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
  print,
  streamSink = null,
  showTurnStatus = true,
  pendingImages = [],
  clearPendingImages = null
}) {
  const normalized = normalizeSlashAlias(String(line || "").trim())

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
    print(
      renderReplDashboard({
        theme: ctx.themeState.theme,
        state,
        providers: providersConfigured,
        recentSessions: latest,
        customCommandCount: customCommands.length,
        cwd: process.cwd()
      })
    )
    print("")
    print(runtimeStateText(state))
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
        print(`  ${s.id.slice(0, 12)}  ${padRight(s.mode, 9)} ${padRight(s.model || "?", 20)} ${padRight(s.status || "-", 14)} ${age}`)
      }
    }
    return { exit: false }
  }

  if (normalized === "/resume" || normalized.startsWith("/resume ") || normalized === "/r" || normalized.startsWith("/r ")) {
    const arg = normalized.replace(/^\/(resume|r)/, "").trim()
    const sessions = await listSessions({ cwd: process.cwd(), limit: 20, includeChildren: false })
    let target = null
    if (!arg) target = sessions[0] || null
    else target = sessions.find((s) => s.id === arg || s.id.startsWith(arg)) || null

    if (!target) {
      print(arg ? `no session matching "${arg}"` : "no sessions to resume")
      return { exit: false }
    }

    state.sessionId = target.id
    state.mode = target.mode || state.mode
    state.providerType = target.providerType || state.providerType
    state.model = target.model || state.model
    print(`resumed session: ${target.id} (${target.mode}, ${target.model || "?"})`)
    const msgs = await getConversationHistory(target.id, 3)
    for (const m of msgs) {
      const preview = m.content.length > 84 ? `${m.content.slice(0, 84)}...` : m.content
      print(`  [${m.role}] ${preview}`)
    }
    return { exit: false }
  }

  if (["/ask", "/plan", "/agent", "/longagent"].includes(normalized)) {
    state.mode = resolveMode(normalized.slice(1))
    print(`mode switched: ${state.mode}`)
    return { exit: false }
  }

  if (normalized.startsWith("/mode ") || normalized.startsWith("/m ")) {
    const next = resolveMode(normalized.replace(/^\/(mode|m)\s+/, "").trim())
    state.mode = next
    print(`mode switched: ${next}`)
    return { exit: false }
  }

  if (normalized === "/provider" || normalized === "/p") {
    print(`available providers: ${providersConfigured.join(", ")}`)
    return { exit: false }
  }

  if (normalized.startsWith("/provider ") || normalized.startsWith("/p ")) {
    const next = normalized.replace(/^\/(provider|p)\s+/, "").trim()
    if (!providersConfigured.includes(next)) {
      print(`provider must be one of: ${providersConfigured.join(", ")}`)
      return { exit: false }
    }
    state.providerType = next
    state.model = resolveProviderDefaultModel(ctx.configState.config, next, state.model)
    print(`provider switched: ${next}`)
    return { exit: false }
  }

  if (normalized === "/model") {
    print(`current: ${state.providerType} / ${state.model}`)
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
    const clipBlock = await readClipboardImage()
    if (!clipBlock) {
      print("no image found in clipboard")
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
      pendingImages: allImages
    })
    const result = turn.result
    const status = renderStatusBar({
      mode: state.mode, model: state.model,
      permission: ctx.configState.config.permission.default_policy,
      tokenMeter: result.tokenMeter, aggregation: ctx.configState.config.usage.aggregation,
      cost: result.cost, savings: result.costSavings, contextMeter: result.context,
      showCost: ctx.configState.config.ui.status.show_cost,
      showTokenMeter: ctx.configState.config.ui.status.show_token_meter,
      theme: ctx.themeState.theme, layout: ctx.configState.config.ui.layout,
      longagentState: state.mode === "longagent" ? result.longagent : null,
      memoryLoaded: state.memoryLoaded
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
        provider: state.providerType
      })
      if (!expanded) {
        print(`skill /${name} returned no output`)
        return { exit: false }
      }
      prompt = expanded
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
    pendingImages: images
  })
  const result = turn.result

  const status = renderStatusBar({
    mode: state.mode,
    model: state.model,
    permission: ctx.configState.config.permission.default_policy,
    tokenMeter: result.tokenMeter,
    aggregation: ctx.configState.config.usage.aggregation,
    cost: result.cost,
    savings: result.costSavings,
    contextMeter: result.context,
    showCost: ctx.configState.config.ui.status.show_cost,
    showTokenMeter: ctx.configState.config.ui.status.show_token_meter,
    theme: ctx.themeState.theme,
    layout: ctx.configState.config.ui.layout,
    longagentState: state.mode === "longagent" ? result.longagent : null,
    memoryLoaded: state.memoryLoaded
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
  }
  if (result.toolEvents.length) print(`tool events: ${result.toolEvents.length}`)

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

  console.log(
    renderReplLogo({
      theme: ctx.themeState.theme,
      columns: Number(process.stdout.columns || 120)
    })
  )
  const hint = renderStartupHint(recentSessions)
  if (hint) console.log(`${hint}\n`)

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
    const status = renderStatusBar({
      mode: state.mode,
      model: state.model,
      permission: ctx.configState.config.permission.default_policy,
      tokenMeter: lastTurn.tokenMeter,
      aggregation: ctx.configState.config.usage.aggregation,
      cost: lastTurn.cost,
      savings: lastTurn.costSavings,
      contextMeter: lastTurn.context,
      showCost: ctx.configState.config.ui.status.show_cost,
      showTokenMeter: ctx.configState.config.ui.status.show_token_meter,
      theme: ctx.themeState.theme,
      layout: ctx.configState.config.ui.layout,
      longagentState: state.mode === "longagent" ? lastTurn.longagent : null,
      memoryLoaded: state.memoryLoaded
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
      print: (text) => console.log(text),
      pendingImages: linePendingImages,
      clearPendingImages: () => { linePendingImages = [] }
    })

    if (action.cleared) clearScreen()
    if (action.dashboardRefresh) {
      const latest = action.recentSessions || []
      console.log(
        renderReplDashboard({
          theme: ctx.themeState.theme,
          state,
          providers: providersConfigured,
          recentSessions: latest,
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
  await saveHistoryLines(entered)
}

function startTuiFrame() {
  output.write("\x1b[?1049h")
  output.write("\x1b[?25l")
}

function stopTuiFrame() {
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

  function appendStreamChunk(chunk = "") {
    const follow = ui.scrollOffset === 0
    const text = String(chunk || "").replace(/\r/g, "")
    if (!text) return
    const parts = text.split("\n")
    if (!ui.logs.length) ui.logs.push("")
    ui.logs[ui.logs.length - 1] += parts[0]
    for (let i = 1; i < parts.length; i++) ui.logs.push(parts[i])
    if (ui.logs.length > MAX_TUI_LOG_LINES) ui.logs.splice(0, ui.logs.length - MAX_TUI_LOG_LINES)
    if (follow) ui.scrollOffset = 0
    requestRender()
  }

  const activityRenderer = createActivityRenderer({
    theme: ctx.themeState.theme,
    output: { appendLog, appendStreamChunk }
  })
  activityRenderer.start()

  const uiEventUnsub = EventBus.subscribe((event) => {
    const { type, payload } = event
    switch (type) {
      case EVENT_TYPES.TURN_STEP_START:
        ui.currentStep = payload.step || 0
        ui.maxSteps = Number(ctx.configState.config.agent?.max_steps) || 25
        ui.currentActivity = { type: "thinking" }
        requestRender()
        break
      case EVENT_TYPES.TOOL_START:
        ui.currentActivity = { type: "tool", tool: payload.tool, args: payload.args }
        requestRender()
        break
      case EVENT_TYPES.TOOL_FINISH:
      case EVENT_TYPES.TOOL_ERROR:
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
    const items = []
    const providerConfig = ctx.configState.config.provider || {}
    for (const [name, conf] of Object.entries(providerConfig)) {
      if (!conf || typeof conf !== "object" || !conf.models) continue
      for (const model of conf.models) {
        items.push({ provider: name, model, label: `${name} / ${model}` })
      }
    }
    return items
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

  function scrollToTop() {
    ui.scrollOffset = ui.scrollMeta.maxOffset || 0
  }

  function scrollToBottom() {
    ui.scrollOffset = 0
  }

  function buildFrame() {
    const width = Number(process.stdout.columns || 120)
    const height = Number(process.stdout.rows || 40)

    const dashboardLines = ui.showDashboard
      ? renderReplLogo({
          theme: ctx.themeState.theme,
          columns: width
        }).split("\n")
      : []

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

    const status = renderStatusBar({
      mode: state.mode,
      model: state.model,
      permission: ctx.configState.config.permission.default_policy,
      tokenMeter: ui.metrics.tokenMeter,
      aggregation: ctx.configState.config.usage.aggregation,
      cost: ui.metrics.cost,
      savings: ui.metrics.costSavings,
      contextMeter: ui.metrics.context,
      showCost: ctx.configState.config.ui.status.show_cost,
      showTokenMeter: ctx.configState.config.ui.status.show_token_meter,
      theme: ctx.themeState.theme,
      layout: ctx.configState.config.ui.layout,
      longagentState: state.mode === "longagent" ? ui.metrics.longagent : null,
      memoryLoaded: state.memoryLoaded
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
    const inputDecorated = `${ui.busy ? "[running] " : "[ready] "}${imgTag}> ${before}${cursorMark}${after}`
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
          : toolName === "enter_plan" || toolName === "exit_plan" ? "magenta"
          : "cyan"
        const detail = formatBusyToolDetail(toolName, ui.currentActivity.args)
        busyLine = `${paint(spinner, toolColor)} ${paint(toolName, toolColor, { bold: true })}${detail}${stepTag}`
      } else {
        busyLine = `${paint(spinner, ctx.themeState.theme.semantic.warn)} ${paint("thinking", ctx.themeState.theme.semantic.warn, { bold: true })}${stepTag}`
      }
    } else if (ui.busy) {
      const spinner = BUSY_SPINNER_FRAMES[ui.spinnerIndex]
      busyLine = `${paint(spinner, ctx.themeState.theme.semantic.warn)} ${paint("thinking", ctx.themeState.theme.semantic.warn, { bold: true })}`
    } else {
      busyLine = paint("ready", ctx.themeState.theme.base.muted, { dim: true })
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
      ? paint(`Scroll: older +${ui.scrollOffset} lines (PgDn/End -> latest)`, ctx.themeState.theme.semantic.warn)
      : paint("Scroll: follow mode (PgUp back, PgDn forward, Home oldest, End latest)", ctx.themeState.theme.base.muted)

    lines.push(clipAnsiLine(paint("Activity", ctx.themeState.theme.semantic.warn, { bold: true }), width))

    for (let i = 0; i < logRows; i++) {
      lines.push(clipAnsiLine(wrappedLogs[i] || "", width))
    }

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
    for (const inputLine of visibleInput) {
      const left = paint("│ ", ctx.themeState.theme.base.border)
      const right = paint(" │", ctx.themeState.theme.base.border)
      lines.push(`${left}${clipAnsiLine(inputLine, inputInnerWidth)}${right}`)
    }
    lines.push(inputBottom)
    lines.push(clipAnsiLine(paint("? for shortcuts | Enter send | Shift+Enter newline | Ctrl+V paste image", ctx.themeState.theme.base.muted), width))

    const final = lines.slice(0, Math.max(1, height))
    while (final.length < height) final.push(" ".repeat(width))

    return { lines: final, width, height }
  }

  function paintFrame(frame) {
    if (!frame || !Array.isArray(frame.lines)) return
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

    ui.history.push(line)
    if (ui.history.length > HIST_SIZE) ui.history.splice(0, ui.history.length - HIST_SIZE)
    ui.historyIndex = ui.history.length

    appendLog(`> ${line}`)
    appendLog("")
    ui.input = ""
    ui.inputCursor = 0
    ui.selectedSuggestion = 0
    ui.suggestionOffset = 0
    ui.busy = true
    startBusySpinner()
    requestRender()

    try {
      const action = await processInputLine({
        line,
        state,
        ctx,
        providersConfigured,
        customCommands: localCustomCommands,
        setCustomCommands: (next) => {
          localCustomCommands = next
        },
        print: appendLog,
        streamSink: appendStreamChunk,
        showTurnStatus: false,
        pendingImages: ui.pendingImages,
        clearPendingImages: () => { ui.pendingImages = [] }
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
        ui.metrics.context = action.turnResult.context || null
        ui.metrics.longagent = action.turnResult.longagent || null
        ui.metrics.toolEvents = action.turnResult.toolEvents || []
      }
      if (!action.dashboardRefresh && !line.startsWith("/")) ui.showDashboard = false
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
      appendLog(`error: ${error.message}`)
    } finally {
      ui.busy = false
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
    if (!ui.history.length) return
    if (keyName === "up") {
      if (ui.historyIndex > 0) ui.historyIndex -= 1
      setInputFromHistory(ui.history[ui.historyIndex] || "")
      return
    }
    if (ui.historyIndex < ui.history.length - 1) {
      ui.historyIndex += 1
      setInputFromHistory(ui.history[ui.historyIndex] || "")
      return
    }
    ui.historyIndex = ui.history.length
    setInputFromHistory("")
  }

  function applyCurrentSuggestion() {
    const suggestions = slashSuggestions(ui.input, localCustomCommands)
    if (!suggestions.length) return
    const chosen = suggestions[Math.max(0, Math.min(ui.selectedSuggestion, suggestions.length - 1))]
    ui.input = applySuggestionToInput(ui.input, chosen.name)
    ui.inputCursor = ui.input.length
  }

  function shouldApplySuggestionOnEnter() {
    const suggestions = slashSuggestions(ui.input, localCustomCommands)
    if (!suggestions.length) return false
    if (!String(ui.input || "").startsWith("/")) return false
    const body = String(ui.input || "").slice(1)
    const firstSpace = body.indexOf(" ")
    if (firstSpace >= 0) return false
    const token = body.trim()
    if (!token) return true
    const chosen = suggestions[Math.max(0, Math.min(ui.selectedSuggestion, suggestions.length - 1))]
    return chosen && chosen.name !== token
  }

  function cycleModeForwardAndNotify() {
    const next = cycleMode(state)
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
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.resume()

  // Disable mouse tracking to prevent interference
  // This allows terminal's native right-click menu and scroll to work properly
  process.stdout.write("\x1b[?1000l\x1b[?1006l")

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

        if (key.ctrl && key.name === "c") {
          ui.quitting = true
          finish()
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

        if (ui.busy) return

        // Ctrl+V: try image first, fall back to text paste
        if (key.ctrl && key.name === "v") {
          const clipBlock = await readClipboardImage()
          if (clipBlock) {
            ui.pendingImages.push(clipBlock)
            appendLog(`image pasted (${ui.pendingImages.length} attached)`)
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
          if (ui.inputCursor > 0) {
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
          const head = ui.input.slice(0, ui.inputCursor)
          const tail = ui.input.slice(ui.inputCursor + 1)
          ui.input = `${head}${tail}`
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

        if (key.name === "up" || key.name === "down") {
          // Ctrl+Up/Down: scroll the log area
          if (key.ctrl) {
            scrollBy(key.name === "up" ? 3 : -3)
            requestRender()
            return
          }
          const handled = handleUpDownSuggestions(key.name)
          if (!handled) navigateHistory(key.name)
          requestRender()
          return
        }

        if (key.ctrl && key.name === "l" && !key.shift) {
          ui.logs = []
          requestRender()
          return
        }

        if (typeof str === "string" && str.length > 0 && !key.ctrl && !key.meta) {
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
        ui.quitting = true
        finish()
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
    stopTuiFrame()
    await saveHistoryLines(ui.history)
  }
}

function startSplash() {
  if (!process.stdout.isTTY) return { update() {}, stop() {} }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  const logo = [
    " _  __ _  __  ____   ___   ____   _____ ",
    "| |/ /| |/ / / ___| / _ \\ |  _ \\ | ____|",
    "| ' / | ' / | |    | | | || | | ||  _|  ",
    "| . \\ | . \\ | |___ | |_| || |_| || |___ ",
    "|_|\\_\\|_|\\_\\ \\____| \\___/ |____/ |_____|",
    "                 v0.1.1                  "
  ]
  const palette = ["#6ec1ff", "#52b7ff", "#36d8d3", "#3fd487", "#f1c55b", "#aaa"]
  let idx = 0
  let status = "loading config..."
  let steps = []

  function render() {
    const cols = process.stdout.columns || 80
    const rows = process.stdout.rows || 24
    const lines = []
    // vertical centering
    const contentHeight = logo.length + 2 + steps.length + 2
    const topPad = Math.max(0, Math.floor((rows - contentHeight) / 2))
    for (let i = 0; i < topPad; i++) lines.push("")
    // logo
    for (let i = 0; i < logo.length; i++) {
      const pad = Math.max(0, Math.floor((cols - logo[i].length) / 2))
      lines.push(" ".repeat(pad) + paint(logo[i], palette[i], { bold: true }))
    }
    lines.push("")
    // completed steps
    for (const s of steps) {
      const pad = Math.max(0, Math.floor((cols - s.length - 4) / 2))
      lines.push(" ".repeat(pad) + paint(`  ✓ ${s}`, "#3fd487"))
    }
    // current spinner line
    const spinLine = `${frames[idx]} ${status}`
    const spinPad = Math.max(0, Math.floor((cols - spinLine.length - 2) / 2))
    lines.push(" ".repeat(spinPad) + paint(`  ${spinLine}`, "#6ec1ff", { bold: true }))
    // write
    process.stdout.write("\x1B[?25l")  // hide cursor
    process.stdout.write("\x1Bc")       // clear
    process.stdout.write(lines.join("\n"))
  }

  render()
  const timer = setInterval(() => { idx = (idx + 1) % frames.length; render() }, 80)

  return {
    update(text) {
      steps.push(status.replace("...", ""))
      status = text
      render()
    },
    stop() {
      clearInterval(timer)
      process.stdout.write("\x1B[?25h")  // show cursor
      process.stdout.write("\x1Bc")       // clear
    }
  }
}

export async function startRepl({ trust = false } = {}) {
  // Trust check BEFORE splash — readline prompt must not compete with splash screen clearing
  const { checkWorkspaceTrust } = await import("./permission/workspace-trust.mjs")
  const trustState = await checkWorkspaceTrust({ cwd: process.cwd(), cliTrust: trust, isTTY: process.stdin.isTTY })

  const splash = startSplash()

  const ctx = await buildContext({ trust, trustState })
  printContextWarnings(ctx)

  splash.update("loading tools & MCP servers...")
  await ToolRegistry.initialize({ config: ctx.configState.config, cwd: process.cwd() })

  // Collect MCP status for later display
  const mcpHealth = McpRegistry.healthSnapshot()
  const mcpStatusLines = []
  for (const entry of mcpHealth) {
    if (entry.ok) {
      const toolCount = McpRegistry.listTools().filter((t) => t.server === entry.name).length
      mcpStatusLines.push(paint(`  mcp ✓ ${entry.name}`, ctx.themeState.theme.semantic.success) + paint(` (${toolCount} tools, ${entry.transport})`, ctx.themeState.theme.base.muted))
    } else {
      const reason = entry.error || entry.reason || "unknown"
      mcpStatusLines.push(paint(`  mcp ✗ ${entry.name}`, ctx.themeState.theme.semantic.error) + paint(` ${reason}`, ctx.themeState.theme.base.muted))
    }
  }

  splash.update("loading skills & agents...")
  await SkillRegistry.initialize(ctx.configState.config, process.cwd())
  const { CustomAgentRegistry } = await import("./agent/custom-agent-loader.mjs")
  await CustomAgentRegistry.initialize(process.cwd())

  splash.update("loading hooks & history...")
  await initHookBus()
  const historyLines = await loadHistory()

  splash.update("preparing workspace...")
  const state = {
    sessionId: newSessionId(),
    mode: ctx.configState.config.agent.default_mode || "agent",
    providerType: ctx.configState.config.provider.default,
    model: ""
  }
  state.model = resolveProviderDefaultModel(ctx.configState.config, state.providerType)

  // Check if auto memory file exists
  try {
    await readFile(memoryFilePath(process.cwd()), "utf8")
    state.memoryLoaded = true
  } catch {
    state.memoryLoaded = false
  }

  const customCommands = await loadCustomCommands(process.cwd())
  const providersConfigured = configuredProviders(ctx.configState.config)
  const recentSessions = await listSessions({ cwd: process.cwd(), limit: 6, includeChildren: false }).catch(() => [])

  splash.stop()

  PermissionEngine.setTrusted(ctx.trustState?.trusted !== false)
  if (!ctx.trustState?.trusted) {
    console.log(paint("  ⚠ workspace not trusted — tools are blocked. Run /trust to enable.", ctx.themeState.theme.semantic.warning))
  }

  if (process.stdout.isTTY && process.stdin.isTTY) {
    await startTuiRepl({
      ctx,
      state,
      providersConfigured,
      customCommands,
      recentSessions,
      historyLines,
      mcpStatusLines
    })
    return
  }

  clearScreen()
  for (const line of mcpStatusLines) console.log(line)
  await startLineRepl({
    ctx,
    state,
    providersConfigured,
    customCommands,
    recentSessions,
    historyLines
  })
}
