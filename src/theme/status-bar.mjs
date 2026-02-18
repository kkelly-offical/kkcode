import { paint } from "./color.mjs"

function formatNumber(value) {
  return Intl.NumberFormat("en-US").format(Math.round(value))
}

function formatCost(amount) {
  if (amount === null || amount === undefined) return "unknown"
  return `$${amount.toFixed(4)}`
}

function permissionColor(permission, theme) {
  switch (permission) {
    case "allow": return theme.semantic.success || theme.semantic.info
    case "deny": return theme.semantic.error || theme.semantic.warn
    case "ask":
    default:
      return theme.semantic.info
  }
}

function contrastText(hex, dark = "#111111", light = "#f7f7f7") {
  if (!/^#([A-Fa-f0-9]{6})$/.test(String(hex || ""))) return light
  const raw = hex.replace("#", "")
  const r = parseInt(raw.slice(0, 2), 16)
  const g = parseInt(raw.slice(2, 4), 16)
  const b = parseInt(raw.slice(4, 6), 16)
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return y > 150 ? dark : light
}

function badge(text, fg, bg, options = {}) {
  return paint(` ${text} `, fg, { bg, bold: options.bold !== false })
}

function clipModel(model, maxLen) {
  const value = String(model || "")
  if (value.length <= maxLen) return value
  if (maxLen < 10) return value.slice(0, maxLen)
  return `${value.slice(0, Math.max(4, maxLen - 4))}...`
}

export function renderStatusBar({
  mode,
  model,
  permission,
  tokenMeter,
  aggregation = ["turn", "session", "global"],
  cost,
  savings = 0,
  showCost = true,
  showTokenMeter = true,
  contextMeter = null,
  theme,
  layout = "compact",
  longagentState = null,
  memoryLoaded = false
}) {
  const width = Number(process.stdout.columns || 120)
  const dense = width < 110
  const tight = width < 86
  const modelLabel = clipModel(model, tight ? 18 : dense ? 28 : 44)

  const segments = []
  const modeBg = theme.modes[mode] || theme.base.accent
  segments.push(badge(mode.toUpperCase(), contrastText(modeBg), modeBg))
  segments.push(badge(`MODEL ${modelLabel}`, theme.base.fg, theme.components.panel || theme.base.border, { bold: false }))

  if (showTokenMeter && tokenMeter) {
    const t = tokenMeter.turn
    const s = tokenMeter.session
    const g = tokenMeter.global
    const tokenSegments = []
    if (aggregation.includes("turn")) tokenSegments.push(`T:${formatNumber(t.input + t.output)}`)
    if (!tight && aggregation.includes("session")) tokenSegments.push(`S:${formatNumber(s.input + s.output)}`)
    if (!dense && aggregation.includes("global")) tokenSegments.push(`G:${formatNumber(g.input + g.output)}`)
    const tokenText = `TOKENS ${tokenSegments.join(" ")}${tokenMeter.estimated ? " ~" : ""}`
    segments.push(
      badge(tokenText, theme.base.fg, "#2d3748", { bold: false })
    )
  }
  if (showCost) {
    const savingsStr = savings > 0 ? ` ↓${formatCost(savings)}` : ""
    segments.push(badge(`COST ${formatCost(cost)}${savingsStr}`, contrastText(theme.semantic.warn), theme.semantic.warn, { bold: false }))
  }
  if (contextMeter && Number.isFinite(contextMeter.percent)) {
    const pct = Math.max(0, Math.min(100, Math.round(contextMeter.percent)))
    const ctxBg = pct >= 85
      ? theme.semantic.error
      : pct >= 70
        ? theme.semantic.warn
        : theme.semantic.info
    let suffix = ""
    if (contextMeter.cacheRead > 0 || contextMeter.cacheWrite > 0) {
      const total = (contextMeter.cacheRead || 0) + (contextMeter.cacheWrite || 0) + (contextMeter.inputUncached || 0)
      const hitPct = total > 0 ? Math.round((contextMeter.cacheRead || 0) / total * 100) : 0
      suffix = ` C:${hitPct}%`
    }
    const text = tight ? `CTX ${pct}%` : `CONTEXT ${pct}%${suffix}`
    segments.push(badge(text, contrastText(ctxBg), ctxBg, { bold: false }))
  }
  if (memoryLoaded && !tight) {
    segments.push(badge("MEM", contrastText(theme.semantic.info), theme.semantic.info, { bold: false }))
  }
  const permBg = permissionColor(permission, theme)
  segments.push(badge(`PERMISSION ${permission.toUpperCase()}`, contrastText(permBg), permBg, { bold: false }))
  if (longagentState && mode === "longagent") {
    const parts = []
    if (longagentState.currentStageId) {
      parts.push(`STG:${longagentState.currentStageId}`)
    } else if (Number.isFinite(longagentState.stageIndex) && Number.isFinite(longagentState.stageCount) && longagentState.stageCount > 0) {
      parts.push(`STG:${longagentState.stageIndex + 1}/${longagentState.stageCount}`)
    }
    if (longagentState.stageProgress?.total) {
      parts.push(`TSK:${longagentState.stageProgress.done || 0}/${longagentState.stageProgress.total}`)
    }
    if (Number.isFinite(longagentState.remainingFilesCount)) {
      parts.push(`REM:${longagentState.remainingFilesCount}`)
    }
    if (longagentState.phase) {
      parts.push(`P:${longagentState.phase}`)
    }
    if (longagentState.currentGate) {
      parts.push(`G:${longagentState.currentGate}`)
    }
    if (longagentState.iterations !== undefined) {
      const iter = longagentState.maxIterations
        ? `${longagentState.iterations}/${longagentState.maxIterations}`
        : String(longagentState.iterations)
      parts.push(`I:${iter}`)
    }
    if (!tight && longagentState.progress?.percentage !== null && longagentState.progress?.percentage !== undefined) {
      const pct = longagentState.progress.percentage
      const barW = dense ? 8 : 14
      const filled = Math.round(barW * pct / 100)
      parts.push(`${"█".repeat(filled)}${"░".repeat(barW - filled)} ${pct}%`)
    }
    if (!dense && longagentState.elapsed !== undefined) {
      const m = Math.floor(longagentState.elapsed / 60)
      const s = longagentState.elapsed % 60
      parts.push(`${m}m${s}s`)
    }
    if (!tight && Array.isArray(longagentState.lastGateFailures) && longagentState.lastGateFailures.length) {
      parts.push(`Fail`)
    }
    if (!tight && typeof longagentState.recoveryCount === "number" && longagentState.recoveryCount > 0) {
      parts.push(`R:${longagentState.recoveryCount}`)
    }
    if (parts.length) {
      segments.push(badge(`LONG ${parts.join(" ")}`, contrastText(theme.semantic.success), theme.semantic.success, { bold: false }))
    }
  }

  if (layout === "comfortable") {
    return segments.join("  ")
  }
  return segments.join(" ")
}
