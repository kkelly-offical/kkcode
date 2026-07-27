import { padRight } from "../repl/frame-primitives.mjs"

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
  lines.push(row("/assistant", "return to the unified assistant"))
  lines.push(row("/plan [request]", "read-only development planning workflow"))
  lines.push(row("/agent /code /coding", "compatibility aliases for assistant"))
  lines.push(row("/ultra [request]", "explicit persistent staged development mode"))
  lines.push(row("/longagent [request]", "deprecated alias for /ultra"))
  lines.push(row("/provider,/p", "list configured providers and pick one"))
  lines.push(row("/provider <type>", `switch directly (${providers.join("|") || "configured"})`))
  lines.push(row("/provider add", "add a new provider (wizard)"))
  lines.push(row("/provider edit <name>", "edit existing provider config"))
  lines.push(row("/model <id>", "set active model"))
  lines.push(row("/mode [id]", "open the mode picker or switch directly (Shift+Tab cycles)"))
  lines.push(row("", "assistant = unified daily lane · plan = read-only planning · longagent = staged"))
  lines.push(row("", "0.4.0 names: Plan · Agent · Agent·Auto · Ultra · YOLO"))

  lines.push("")
  lines.push("  Profile & Workspace")
  lines.push(row("/profile", "view or edit your user profile"))
  lines.push(row("/like", "show welcome screen / re-run onboarding"))
  lines.push(row("/trust", "trust this workspace"))
  lines.push(row("/untrust", "revoke workspace trust"))

  lines.push("")
  lines.push("  Tools & Display")
  lines.push(row("/permission [...]", "adjust permission level/policy"))
  lines.push(row("/paste [text]", "attach clipboard image (Ctrl+V does the same, inline)"))
  lines.push(row("/status", "show current runtime state"))
  lines.push(row("/dash,/home", "redraw dashboard"))
  lines.push(row("/clear,/cls", "clear terminal"))
  lines.push(row("/keys,/k", "show key map"))

  lines.push("")
  lines.push("  Custom Extensions")
  lines.push(row("/commands", "list custom slash commands"))
  lines.push(row("/skills", "list registered skills, their source and how to invoke them"))
  lines.push(row("/create-skill <desc>", "generate a new skill via AI"))
  lines.push(row("$<skill> [args]", "invoke a registered skill"))
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
  lines.push("  agent.default_mode            startup mode (assistant|plan|longagent)")
  lines.push("  agent.longagent.git.enabled   git branch mgmt (true|false|\"ask\")")
  lines.push("  permission.level              tool approvals (readonly|manual|accept-edits|yolo)")
  lines.push("  permission.rules              persistent allow/deny rules incl. Always Allow")
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
    "  /m      Switch explicit mode",
    "  /p      Switch provider",
    "  /k      Show this key map",
    "  /permission [show|readonly|manual|accept-edits|yolo|list|forget <n|all>|non-tty <allow_once|deny>|save [project|user]|session-clear]",
    "  /dash   Redraw dashboard",
    "  /clear  Clear screen",
    "  /assistant /plan /longagent  Explicit workflows",
    "",
    "TUI keys:",
    "  Enter choose slash suggestion / submit prompt",
    "  Ctrl+J insert newline (Shift+Enter if terminal supports)",
    "  Ctrl+V paste — image if the clipboard holds one, otherwise text",
    "         images become an inline [Image #N] marker; delete it to drop the image",
    "         a long paste folds into [Pasted text #N +M chars] and expands on send",
    "  /paste attach a clipboard image without leaving the keyboard",
    "  Up/Down navigate suggestion/history",
    "  Left/Right/Home/End edit cursor",
    "  Ctrl+Up/Down scroll log   Ctrl+Home/End oldest/latest",
    "  Tab/Ctrl+F accept ghost text (needs models.fast)",
    "  Shift+Tab cycle mode (Plan/Agent/Agent·Auto/Ultra/YOLO)",
    "  /permission cycle  cycle approval level",
    "  Esc interrupt turn  Esc×2 rewind one turn  Ctrl+C×2 exit"
  ].join("\n")
}
