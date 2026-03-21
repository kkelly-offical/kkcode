import { homedir } from "node:os"
import { resolve } from "node:path"
import { paint } from "../theme/color.mjs"

function stripAnsi(text) {
  return String(text || "").replace(/\x1B\[[0-9;]*m/g, "")
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

function visibleWidth(text) {
  let width = 0
  for (const ch of stripAnsi(text)) {
    width += isFullWidthCodePoint(ch.codePointAt(0)) ? 2 : 1
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

function padCell(text, width) {
  const raw = stripAnsi(text)
  const w = visibleWidth(raw)
  if (w === width) return text
  if (w < width) return text + " ".repeat(width - w)
  if (width <= 1) return clipPlainByWidth(raw, width)
  return clipPlainByWidth(raw, Math.max(1, width - 1)) + "…"
}

function wrapPlain(text, width) {
  if (width <= 4) return [clipPlainByWidth(String(text || ""), Math.max(width, 1))]
  const words = String(text || "").split(/\s+/).filter(Boolean)
  if (!words.length) return [""]
  const out = []
  let line = ""
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (visibleWidth(candidate) <= width) {
      line = candidate
      continue
    }
    if (line) out.push(line)
    if (visibleWidth(word) <= width) {
      line = word
      continue
    }
    let rest = word
    while (visibleWidth(rest) > width) {
      const part = clipPlainByWidth(rest, width)
      out.push(part)
      rest = rest.slice(part.length)
    }
    line = rest || ""
  }
  if (line) out.push(line)
  return out.length ? out : [""]
}

function terminalWidth() {
  const cols = Number(process.stdout.columns || 120)
  if (!Number.isFinite(cols) || cols <= 0) return 120
  return Math.max(60, Math.min(cols, 220))
}

function centerLine(text, width) {
  const rawWidth = visibleWidth(text)
  if (rawWidth >= width) return text
  const pad = Math.floor((width - rawWidth) / 2)
  return `${" ".repeat(Math.max(0, pad))}${text}`
}

function shortenPath(path) {
  const home = homedir()
  if (!path) return ""
  const normalizedPath = resolve(path).replace(/\\/g, "/")
  const homeNorm = home ? resolve(home).replace(/\\/g, "/") : ""
  const replaced = (home && normalizedPath.startsWith(`${homeNorm}/`)) || normalizedPath === homeNorm
    ? `~${normalizedPath.slice(homeNorm.length)}`
    : path
  if (replaced.length <= 72) return replaced
  return `...${replaced.slice(-69)}`
}

function formatMcpStatus(summary) {
  if (!summary) return []
  const lines = [
    `MCP: configured ${summary.configured}, healthy ${summary.healthy}, tools ${summary.tools || 0}`
  ]
  if (!summary.configured) {
    lines.push("  quickstart: kkcode mcp init --project --with-skills")
    return lines
  }
  for (const entry of summary.entries || []) {
    const byServer = summary.byServer?.[entry.name]
    const toolCount = byServer !== undefined ? ` (${byServer} tools)` : ""
    lines.push(`  ${entry.ok ? "✓" : "×"} ${entry.name}${toolCount}`)
  }
  return lines
}

function formatSkillStatus(summary) {
  if (!summary) return []
  const mdTotal = summary.template + summary.skillMd
  const lines = [
    `Skills: ${summary.total} loaded`,
    `  markdown: ${mdTotal} (templates: ${summary.template}, dirs: ${summary.skillMd})`,
    `  mcp prompts: ${summary.mcpPrompt}`,
    `  programmable: ${summary.programmable}`
  ]
  if (summary.total === 0) {
    lines.push("  quickstart: kkcode skill init --project")
  }
  if (summary.total > 0) {
    lines.push("  try: /code-review /test-plan")
  }
  return lines
}

function formatLongAgentStatus(longagent, sessionId = null) {
  if (!longagent || typeof longagent !== "object") return []
  const enriched = longagent.sessionId ? longagent : { ...longagent, sessionId: sessionId || null }
  const stageCount = Math.max(0, Number(longagent.stageCount || 0))
  const stageIndex = Math.max(0, Number(longagent.stageIndex || 0))
  const stageLabel = longagent.currentStageId || (stageCount > 0 ? `${Math.min(stageIndex + 1, stageCount)}/${stageCount}` : "-")
  const lines = [
    `LongAgent: ${longagent.status || "idle"} ${longagent.phase ? `(${longagent.phase})` : ""}`.trim(),
    `  stage: ${stageLabel} gate=${longagent.currentGate || "-"}`,
    `  progress: ${longagent.progress?.percentage ?? 0}% recovery=${longagent.recoveryCount || 0}`
  ]
  const lastStage = longagent.lastStageReport
  if (lastStage?.stageId) {
    lines.push(
      `  last stage: ${lastStage.stageId} ${String(lastStage.status || "-").toUpperCase()} ${lastStage.successCount || 0} ok / ${lastStage.failCount || 0} fail`
    )
    if (Number(lastStage.remainingFilesCount || 0) > 0) {
      lines.push(`  remaining files: ${lastStage.remainingFilesCount}`)
    }
  }
  const timeline = formatLongagentTimeline(longagent)
  if (timeline.length) {
    lines.push("  timeline:")
    for (const item of timeline) lines.push(`    ${item}`)
  }
  const recommended = recommendLongagentAction(enriched)
  if (recommended) {
    lines.push(`  recommended: ${compactRecommendedCommand(recommended.command)}`)
    lines.push(`  reason: ${recommended.reason}`)
  }
  return lines
}

function compactRecommendedCommand(command = "") {
  const value = String(command || "")
  const checkpointMatch = value.match(/recover-checkpoint --session [^ ]+ --checkpoint ([^ ]+)/)
  if (checkpointMatch) return `recover-checkpoint ${checkpointMatch[1]}`
  const recoverMatch = value.match(/recover --session ([^ ]+)/)
  if (recoverMatch) return `recover ${recoverMatch[1]}`
  return value
}

function recommendLongagentAction(longagent) {
  if (!longagent?.sessionId) return null
  if (["interrupted", "error", "cancel_requested"].includes(longagent.backgroundTaskStatus || "")) {
    return {
      command: `kkcode longagent recover --session ${longagent.sessionId}`,
      reason: `background task is ${longagent.backgroundTaskStatus}`
    }
  }
  const checkpoints = Array.isArray(longagent.checkpoints) ? longagent.checkpoints : []
  const latestCheckpointId = checkpoints.length ? checkpoints[checkpoints.length - 1].id : null
  if ((longagent.lastStageReport?.status === "fail" || Number(longagent.recoveryCount || 0) > 0) && latestCheckpointId) {
    return {
      command: `kkcode longagent recover-checkpoint --session ${longagent.sessionId} --checkpoint ${latestCheckpointId}`,
      reason: longagent.lastStageReport?.status === "fail"
        ? `last stage ${longagent.lastStageReport.stageId || "-"} failed`
        : `recovery_count=${longagent.recoveryCount || 0}`
    }
  }
  return null
}

function formatLongagentTimeline(longagent, maxItems = 3) {
  if (!longagent || typeof longagent !== "object") return []
  const reports = Array.isArray(longagent.stageReports) ? longagent.stageReports : []
  const checkpoints = Array.isArray(longagent.checkpoints) ? longagent.checkpoints : []
  const items = []

  for (const report of reports.slice(-Math.max(0, maxItems))) {
    items.push(`stage ${report.stageId || "-"} ${String(report.status || "-").toUpperCase()}`)
  }
  for (const checkpoint of checkpoints.slice(-Math.max(0, maxItems))) {
    const summary = String(checkpoint.summary || "").trim()
    items.push(`checkpoint ${checkpoint.phase || "-"} ${checkpoint.kind || "checkpoint"}${summary ? ` ${summary}` : ""}`)
  }
  if (longagent.backgroundTaskId) {
    items.push(`background ${longagent.backgroundTaskStatus || "unknown"} attempt=${longagent.backgroundTaskAttempt || 0}`)
  }

  return items.slice(-Math.max(0, maxItems))
}

function renderTag(theme, label, fg = "#0b0b0b", bg = theme.base.accent) {
  return paint(` ${label} `, fg, { bg, bold: true })
}

function ageLabel(ms) {
  const mins = Math.round(ms / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function flattenSections(sections, width) {
  const lines = []
  for (const [index, section] of sections.entries()) {
    lines.push(paint(section.title, section.color, { bold: true }))
    for (const item of section.items) {
      if (!item) {
        lines.push("")
        continue
      }
      const wrapped = wrapPlain(item, width)
      for (const line of wrapped) lines.push(line)
    }
    if (index !== sections.length - 1) lines.push("")
  }
  return lines
}

function frameLine(content, width, borderColor) {
  const inner = width - 4
  const padded = padCell(content, inner)
  return paint(`| ${padded} |`, borderColor)
}

function drawSingleColumn({ width, theme, sections }) {
  const border = paint(`+${"-".repeat(width - 2)}+`, theme.base.border)
  const out = [border]
  const cellWidth = width - 4
  const lines = flattenSections(sections, cellWidth)
  for (const line of lines) out.push(frameLine(line, width, theme.base.border))
  out.push(border)
  return out
}

function drawDoubleColumn({ width, theme, leftSections, rightSections }) {
  const border = paint(`+${"-".repeat(width - 2)}+`, theme.base.border)
  const out = [border]
  const inner = width - 4
  const gap = 3
  const leftWidth = Math.floor((inner - gap) * 0.5)
  const rightWidth = inner - gap - leftWidth

  const leftLines = flattenSections(leftSections, leftWidth)
  const rightLines = flattenSections(rightSections, rightWidth)
  const rows = Math.max(leftLines.length, rightLines.length)

  for (let i = 0; i < rows; i++) {
    const left = padCell(leftLines[i] || "", leftWidth)
    const right = padCell(rightLines[i] || "", rightWidth)
    out.push(paint(`| ${left} | ${right} |`, theme.base.border))
  }
  out.push(border)
  return out
}

export function renderReplDashboard({
  theme,
  state,
  providers,
  recentSessions,
  customCommandCount,
  providerSwitches = [],
  recoverableSessions = [],
  backgroundSummary = null,
  recentBackgroundTasks = [],
  mcpSummary = null,
  skillSummary = null,
  cwd,
  columns = null
}) {
  const width = Number.isFinite(columns) ? Math.max(60, Math.min(Number(columns), 220)) : terminalWidth()
  const title = `${renderTag(theme, "KKCODE", "#111111", theme.semantic.info)} ${paint("Interactive Coding CLI", theme.base.fg, { bold: true })}`
  const subtitle = paint("Adaptive dashboard + richer command palette", theme.base.muted)

  const recentLines = recentSessions.length
    ? recentSessions.slice(0, 6).map((s) => `${s.id.slice(0, 12)} ${s.mode} ${ageLabel(Date.now() - s.updatedAt)}`)
    : ["(no session yet)"]

  const leftSections = [
    {
      title: "Workspace",
      color: theme.semantic.info,
      items: [shortenPath(cwd)]
    },
    {
      title: "Runtime",
      color: theme.semantic.success,
      items: [
        `Session: ${state.sessionId}`,
        `Mode: ${state.mode}`,
        `Provider: ${state.providerType}`,
        `Model: ${state.model}`,
        ...formatLongAgentStatus(state.longagent, state.sessionId),
        `Custom commands: ${customCommandCount}`,
        ...formatMcpStatus(mcpSummary),
        ...formatSkillStatus(skillSummary)
      ]
    },
    {
      title: "Quick Aliases",
      color: theme.modes.agent,
      items: [
        "/h  /?   help",
        "/n       new session",
        "/r       resume latest",
        "/m       switch mode",
        "/p       switch provider",
        "/k       shortcuts"
      ]
    }
  ]

  const rightSections = [
    {
      title: "Tips",
      color: theme.semantic.warn,
      items: [
        ...[
        "Commands for bootstrap:",
        "  kkcode init --providers",
        "  kkcode auth onboard openai",
        "  kkcode mcp discover",
          "  kkcode mcp init --project",
          "  kkcode skill init",
          "  kkcode auth providers"
        ],
        "Use /dash to redraw this panel",
        "Use /clear to clear screen",
        "Use /model <id> to override model",
        "Use \"\"\" for multi-line prompts",
        "Use kkcode background center for task overview"
      ]
    },
    {
      title: "Recent Activity",
      color: theme.modes.plan,
      items: recentLines
    },
    {
      title: "Task Center",
      color: theme.semantic.warn,
      items: backgroundSummary
        ? [
            `tasks: total=${backgroundSummary.total} running=${backgroundSummary.running} pending=${backgroundSummary.pending} interrupted=${backgroundSummary.interrupted} error=${backgroundSummary.error}`,
            `kinds: longagent=${backgroundSummary.longagent} recovery=${backgroundSummary.recovery}`,
            ...recentBackgroundTasks.slice(0, 3)
          ]
        : ["(no background tasks)"]
    },
    {
      title: "Recovery Center",
      color: theme.semantic.info,
      items: Array.isArray(recoverableSessions) && recoverableSessions.length
        ? [
            `recoverable=${recoverableSessions.length}`,
            ...recoverableSessions.slice(0, 3).map((item) =>
              `${item.id || "-"} ${item.status || "recoverable"} ${item.retryable ? "retry" : "resume"}`
            )
          ]
        : ["(no recoverable sessions)"]
    },
    {
      title: "Providers",
      color: theme.modes.ask,
      items: [
        providers.length ? providers.join(" | ") : "(none configured)",
        ...(Array.isArray(providerSwitches) && providerSwitches.length
          ? ["timeline:", ...providerSwitches.slice(0, 3).map((item) => `  ${item}`)]
          : [])
      ]
    },
    {
      title: "Useful Commands",
      color: theme.modes.longagent,
      items: [
        "/history /resume /commands /reload",
        "/ask /plan /agent /longagent",
        "kkcode session picker",
        "kkcode auth onboard openai",
        "kkcode auth probe openai",
        "kkcode background center"
      ]
    }
  ]

  const lines = [
    title,
    subtitle,
    ""
  ]

  const useSingle = width < 110
  const panel = useSingle
    ? drawSingleColumn({ width, theme, sections: [...leftSections, ...rightSections] })
    : drawDoubleColumn({ width, theme, leftSections, rightSections })

  lines.push(...panel)
  return lines.join("\n")
}

export function renderReplLogo({ theme, columns = null }) {
  const width = Number.isFinite(columns) ? Math.max(60, Math.min(Number(columns), 220)) : terminalWidth()
  const rawLogo = [
    "██╗  ██╗ ██╗  ██╗  ██████╗  ██████╗  ██████╗  ███████╗",
    "██║ ██╔╝ ██║ ██╔╝ ██╔════╝ ██╔═══██╗ ██╔══██╗ ██╔════╝",
    "█████╔╝  █████╔╝  ██║      ██║   ██║ ██║  ██║ █████╗  ",
    "██╔═██╗  ██╔═██╗  ██║      ██║   ██║ ██║  ██║ ██╔══╝  ",
    "██║  ██╗ ██║  ██╗ ╚██████╗ ╚██████╔╝ ██████╔╝ ███████╗",
    "╚═╝  ╚═╝ ╚═╝  ╚═╝  ╚═════╝  ╚═════╝  ╚═════╝  ╚══════╝"
  ]
  const wave = [
    "#4af5f0", "#3de8f5", "#30dbfa", "#38c8ff", "#40b5ff",
    "#58a0ff", "#708bff", "#8876ff", "#a061ff", "#b84cff",
    "#d037ff", "#e828f0", "#f034d0", "#f040b0", "#f04c90",
    "#f040b0", "#f034d0", "#e828f0", "#d037ff", "#b84cff",
    "#a061ff", "#8876ff", "#708bff", "#58a0ff", "#40b5ff",
    "#38c8ff", "#30dbfa", "#3de8f5"
  ]
  const coreLines = rawLogo.map((line, row) => {
    let out = ""
    for (let col = 0; col < line.length; col++) {
      const ch = line[col]
      if (ch === " ") { out += " "; continue }
      const waveIdx = (col + row * 3) % wave.length
      out += paint(ch, wave[waveIdx], { bold: true })
    }
    return out
  })
  coreLines.push(paint("AI Coding Agent", theme.base.fg, { bold: true }))
  coreLines.push(paint("Type /status to open Workspace & Runtime panel", theme.base.muted))

  const mascotRaw = [
    "      /\\      ",
    "     /__\\     ",
    "    /|[]|\\    ",
    "   /_|__|_\\   ",
    "     /||\\     ",
    "    /_||_\\    ",
    "      /\\      "
  ]
  const mascotPalette = [
    "#6ec1ff",
    "#52b7ff",
    "#36d8d3",
    "#3fd487",
    "#f1c55b",
    "#f39b52",
    "#ff7f6e"
  ]
  const mascotLines = mascotRaw.map((line, idx) => paint(line, mascotPalette[idx % mascotPalette.length], { bold: true }))

  // Narrow terminals: keep pure centered logo, avoid cramped side art.
  if (width < 96) {
    const lines = coreLines.map((line) => centerLine(line, width))
    return lines.join("\n")
  }

  // Three-column layout keeps KKCODE visually centered in the full terminal:
  // [mascot] [center logo block] [symmetric spacer]
  const mascotWidth = Math.max(...mascotRaw.map((line) => visibleWidth(line)))
  const sideWidth = mascotWidth + 2
  const centerWidth = Math.max(24, width - (sideWidth * 2))

  const rows = Math.max(coreLines.length, mascotLines.length)
  const mascotTopPad = Math.max(0, Math.floor((rows - mascotLines.length) / 2))
  const logoTopPad = Math.max(0, Math.floor((rows - coreLines.length) / 2))
  const lines = []

  for (let i = 0; i < rows; i++) {
    const mascotIdx = i - mascotTopPad
    const logoIdx = i - logoTopPad
    const left = mascotIdx >= 0 && mascotIdx < mascotLines.length ? mascotLines[mascotIdx] : ""
    const mid = logoIdx >= 0 && logoIdx < coreLines.length ? centerLine(coreLines[logoIdx], centerWidth) : ""
    const leftCell = padCell(left, sideWidth)
    const midCell = padCell(mid, centerWidth)
    const rightCell = " ".repeat(sideWidth)
    lines.push(`${leftCell}${midCell}${rightCell}`)
  }

  return lines.join("\n")
}

export function renderStartupHint(recentSessions = []) {
  if (!recentSessions.length) return ""
  const last = recentSessions[0]
  const age = ageLabel(Date.now() - last.updatedAt)
  return [
    `last session: ${last.id} (${last.mode}, ${age})`,
    `  quick resume: /r ${last.id.slice(0, 12)}`,
    "  recovery:     /picker or Ctrl+R",
    "  auth onboard: kkcode auth onboard openai",
    "  auth catalog: kkcode auth providers",
    "  task center:  kkcode background center"
  ].join("\n")
}
