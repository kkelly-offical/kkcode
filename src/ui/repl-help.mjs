function padRight(text, width) {
  const value = String(text || "")
  return value.length >= width ? value : value + " ".repeat(width - value.length)
}

export function buildHelpText({ providers = [], userRootPath = "" } = {}) {
  const W = 30
  const row = (cmd, desc) => `  ${padRight(cmd, W)} ${desc}`
  const lines = ["", "Commands:"]

  lines.push("")
  lines.push("  Session")
  lines.push(row("/new,/n", "start a new session"))
  lines.push(row("/resume [id],/r [id]", "resume a previous session"))
  lines.push(row("/history", "list recent sessions"))
  lines.push(row("/session,/s", "print current session id"))
  lines.push(row("/compact", "summarize conversation to free context"))
  lines.push(row("/undo", "undo last code changes"))

  lines.push("")
  lines.push("  Mode & Provider")
  lines.push(row("/ask /plan /agent /longagent", "quick mode switch to the public execution lanes"))
  lines.push(row("/mode <name>,/m <name>", "switch mode (ask|plan|agent|longagent) with explicit lane semantics"))
  lines.push(row("/longagent 4stage|hybrid", "switch longagent impl"))
  lines.push(row("/provider <type>,/p <type>", `switch provider (${providers.join("|") || "configured"})`))
  lines.push(row("/provider edit <name>", "edit existing provider config"))
  lines.push(row("/model <id>", "set active model"))
  lines.push(row("", "ask = read-only explanation · plan = spec only · agent = default bounded lane · longagent = staged multi-file lane"))

  lines.push("")
  lines.push("  Profile & Workspace")
  lines.push(row("/profile", "view or edit your user profile"))
  lines.push(row("/like", "show welcome screen / re-run onboarding"))
  lines.push(row("/trust", "trust this workspace"))
  lines.push(row("/untrust", "revoke workspace trust"))

  lines.push("")
  lines.push("  Tools & Display")
  lines.push(row("/permission [...]", "adjust permission policy"))
  lines.push(row("/paste [text]", "paste clipboard image"))
  lines.push(row("/status", "show current runtime state"))
  lines.push(row("/dash,/home", "redraw dashboard"))
  lines.push(row("/clear,/cls", "clear terminal"))
  lines.push(row("/keys,/k", "show key map"))

  lines.push("")
  lines.push("  Custom Extensions")
  lines.push(row("/commands", "list custom slash commands"))
  lines.push(row("/create-skill <desc>", "generate a new skill via AI"))
  lines.push(row("/create-agent <desc>", "generate a new sub-agent via AI"))
  lines.push(row("/reload", "reload commands, skills, agents"))

  lines.push("")
  lines.push(row("/help,/h,/?", "show this help"))
  lines.push(row("/exit,/quit,/q", "quit"))

  lines.push("")
  lines.push("Configuration:")
  lines.push(`  Global config     ${userRootPath}/config.yaml`)
  lines.push("  Project config    kkcode.config.yaml / .kkcode/config.yaml")
  lines.push("  Custom commands   .kkcode/commands/    (project-level slash commands)")
  lines.push(`  Custom skills     ${userRootPath}/skills/    or .kkcode/skills/`)
  lines.push(`  Custom agents     ${userRootPath}/agents/    or .kkcode/agents/`)
  lines.push("  Custom tools      .kkcode/tools/       (project-level tool definitions)")
  lines.push("  Hooks             .kkcode/hooks/       (project-level hook scripts)")
  lines.push("  Plugin packages   .kkcode-plugin/ or .kkcode/plugins/<name>/")
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
  lines.push("  permission.default_policy     tool permission (ask|allow|deny)")
  lines.push("  usage.budget.session_usd      per-session cost limit")
  lines.push("")
  lines.push("See notice.md in project root for full configuration guide.")
  return lines.join("\n")
}

export function buildShortcutLegend() {
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
    "  /ask /plan /agent /longagent  Quick lane switch",
    "",
    "TUI keys:",
    "  Enter choose slash suggestion / submit prompt",
    "  Ctrl+J insert newline (Shift+Enter if terminal supports)",
    "  /paste paste image from clipboard (Ctrl+V if terminal supports)",
    "  Up/Down navigate suggestion/history",
    "  Left/Right/Home/End edit cursor",
    "  Ctrl+Up/Down scroll log   Ctrl+Home/End oldest/latest",
    "  Tab cycle lane (longagent -> plan -> ask -> agent)",
    "  Esc interrupt turn  Ctrl+C×2 exit"
  ].join("\n")
}
