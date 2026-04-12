import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { paint } from "../theme/color.mjs"

export function configuredProviders(config, listProvidersFn) {
  const builtins = new Set(listProvidersFn())
  const out = []
  for (const [name, value] of Object.entries(config.provider || {})) {
    if (name === "default") continue
    if (name === "strict_mode") continue
    if (name === "model_context") continue
    if (!value || typeof value !== "object") continue
    const type = value.type || name
    if (builtins.has(type)) out.push(name)
  }
  return out
}

export async function loadHistoryLines(filePath, size) {
  try {
    const raw = await readFile(filePath, "utf8")
    return raw.split("\n").filter(Boolean).slice(-size)
  } catch {
    return []
  }
}

export async function saveHistoryLines(filePath, size, lines) {
  try {
    await mkdir(dirname(filePath), { recursive: true })
    const finalLines = [...lines].slice(-size)
    await writeFile(filePath, finalLines.join("\n") + (finalLines.length ? "\n" : ""), "utf8")
  } catch {}
}

export function clearScreen(output = process.stdout) {
  if (!output?.isTTY) return
  output.write("\x1Bc")
}

export function resolveProviderDefaultModel(config, providerType, fallback = "") {
  return (
    config.provider?.[providerType]?.default_model ||
    config.provider?.[config.provider?.default]?.default_model ||
    fallback
  )
}

export function createInitialReplState(config, { newSessionIdFn }) {
  const providerType = config.provider.default
  const state = {
    sessionId: newSessionIdFn(),
    mode: config.agent.default_mode || "agent",
    providerType,
    model: ""
  }
  state.model = resolveProviderDefaultModel(config, providerType)
  return state
}

export function collectMcpStatusLines(theme, entries, tools) {
  const lines = []
  for (const entry of entries) {
    if (entry.ok) {
      const toolCount = tools.filter((tool) => tool.server === entry.name).length
      lines.push(
        paint(`  mcp ✓ ${entry.name}`, theme.semantic.success) +
          paint(` (${toolCount} tools, ${entry.transport})`, theme.base.muted)
      )
      continue
    }
    const reason = entry.error || entry.reason || "unknown"
    lines.push(
      paint(`  mcp ✗ ${entry.name}`, theme.semantic.error) +
        paint(` ${reason}`, theme.base.muted)
    )
  }
  return lines
}

export function startSplash({
  paintFn = paint,
  stdout = process.stdout,
  version = "v0.1.27"
} = {}) {
  if (!stdout?.isTTY) return { update() {}, stop() {} }

  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  const logo = [
    "  ██╗  ██╗ ██╗  ██╗  ██████╗  ██████╗  ██████╗  ███████╗ ",
    "  ██║ ██╔╝ ██║ ██╔╝ ██╔════╝ ██╔═══██╗ ██╔══██╗ ██╔════╝ ",
    "  █████╔╝  █████╔╝  ██║      ██║   ██║ ██║  ██║ █████╗   ",
    "  ██╔═██╗  ██╔═██╗  ██║      ██║   ██║ ██║  ██║ ██╔══╝   ",
    "  ██║  ██╗ ██║  ██╗ ╚██████╗ ╚██████╔╝ ██████╔╝ ███████╗ ",
    "  ╚═╝  ╚═╝ ╚═╝  ╚═╝  ╚═════╝  ╚═════╝  ╚═════╝  ╚══════╝ "
  ]
  const tagline = "AI Coding Agent"
  const wave = [
    "#4af5f0", "#3de8f5", "#30dbfa", "#38c8ff", "#40b5ff",
    "#58a0ff", "#708bff", "#8876ff", "#a061ff", "#b84cff",
    "#d037ff", "#e828f0", "#f034d0", "#f040b0", "#f04c90",
    "#f040b0", "#f034d0", "#e828f0", "#d037ff", "#b84cff",
    "#a061ff", "#8876ff", "#708bff", "#58a0ff", "#40b5ff",
    "#38c8ff", "#30dbfa", "#3de8f5"
  ]

  function charColor(ch, hex) {
    if (ch === " " || ch === "\n") return ch
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return `\x1b[1;38;2;${r};${g};${b}m${ch}\x1b[0m`
  }

  let tick = 0
  let status = "loading config..."
  let steps = []
  let revealChars = 0
  const totalChars = logo[0].length
  const revealSpeed = 3

  function render() {
    const cols = stdout.columns || 80
    const rows = stdout.rows || 24
    const lines = []
    const contentHeight = logo.length + 4 + steps.length + 2
    const topPad = Math.max(0, Math.floor((rows - contentHeight) / 2))
    for (let i = 0; i < topPad; i++) lines.push("")

    const visible = Math.min(revealChars, totalChars)
    for (let row = 0; row < logo.length; row++) {
      const line = logo[row]
      const pad = Math.max(0, Math.floor((cols - line.length) / 2))
      let out = " ".repeat(pad)
      for (let col = 0; col < line.length; col++) {
        if (col >= visible) {
          out += " "
          continue
        }
        const ch = line[col]
        const waveIdx = (col + tick * 2 + row * 3) % wave.length
        out += charColor(ch, wave[waveIdx])
      }
      lines.push(out)
    }

    const tagFull = `${tagline}  ·  ${version}`
    if (visible >= totalChars) {
      const tagPad = Math.max(0, Math.floor((cols - tagFull.length) / 2))
      const tagAlpha = Math.min(1, (revealChars - totalChars) / 20)
      const brightness = Math.round(100 + 155 * tagAlpha)
      const hex = brightness.toString(16).padStart(2, "0")
      const tagHex = `#${hex}${hex}${hex}`
      lines.push(" ".repeat(tagPad) + paintFn(tagFull, tagHex, { dim: tagAlpha < 0.5 }))
    } else {
      lines.push("")
    }

    if (visible >= totalChars) {
      const barWidth = Math.min(40, cols - 4)
      const barPad = Math.max(0, Math.floor((cols - barWidth) / 2))
      let bar = ""
      for (let i = 0; i < barWidth; i++) {
        const ci = (i + tick) % wave.length
        bar += charColor("─", wave[ci])
      }
      lines.push(" ".repeat(barPad) + bar)
    } else {
      lines.push("")
    }

    lines.push("")
    for (const step of steps) {
      const pad = Math.max(0, Math.floor((cols - step.length - 4) / 2))
      lines.push(" ".repeat(pad) + paintFn(`  ✓ ${step}`, "#3fd487"))
    }

    const spinChar = frames[tick % frames.length]
    const spinLine = `${spinChar} ${status}`
    const spinPad = Math.max(0, Math.floor((cols - spinLine.length - 2) / 2))
    lines.push(" ".repeat(spinPad) + paintFn(`  ${spinLine}`, "#6ec1ff", { bold: true }))

    stdout.write("\x1B[?25l")
    stdout.write("\x1Bc")
    stdout.write(lines.join("\n"))
  }

  render()
  const timer = setInterval(() => {
    tick += 1
    if (revealChars < totalChars + 30) revealChars += revealSpeed
    render()
  }, 50)

  return {
    update(text) {
      steps.push(status.replace("...", ""))
      status = text
      render()
    },
    stop() {
      clearInterval(timer)
      stdout.write("\x1B[?25h")
      stdout.write("\x1Bc")
    }
  }
}
