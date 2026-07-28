import { paint } from "./color.mjs"
import { getMode } from "../core/modes.mjs"

/**
 * 可配置状态栏（0.8.1）的段名清单 —— **唯一来源**。
 *
 * `ui.status.segments` 的合法值、schema 校验、渲染表都从这里派生；
 * 手写第二份清单的话，加段时 schema 与渲染就会静默分叉（枚举清单的老课）。
 * 顺序即缺省显示顺序。
 */
export const STATUS_SEGMENT_IDS = Object.freeze([
  "mode", "model", "tokens", "cost", "context", "memory", "permission", "longagent"
])

function formatNumber(value) {
  return Intl.NumberFormat("en-US").format(Math.round(value))
}

/** 193400 → "193.4K"，1250000 → "1.3M"，950 → "950" */
export function formatTokenCount(tokens) {
  const n = Number(tokens) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function formatCost(amount) {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return "—"
  return `$${amount.toFixed(4)}`
}

function permissionColor(permission, theme) {
  switch (permission) {
    case "allow":
    case "yolo":
      return theme.semantic.success || theme.semantic.info
    case "deny": return theme.semantic.error || theme.semantic.warn
    case "auto": return theme.semantic.warn || theme.semantic.info
    case "manual":
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
  modeId = null,
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
  memoryLoaded = false,
  /**
   * `ui.status.segments`：要显示哪些段、按什么顺序（0.8.1）。
   * null/空 = 全量按缺省顺序（现状不变）。段名以 STATUS_SEGMENT_IDS 为准，
   * 列了但当前不适用的段（如非 longagent 模式下的 longagent）静默跳过。
   */
  segments: segmentOrder = null,
  // 排版宽度由调用方给。0.6.1 修了「装不下时丢哪个段」，但宽度仍直读
  // process.stdout.columns —— 测试进程里它恒为 undefined（回落 120），所以
  // 分档逻辑永远走同一条路，而真实的 86 列终端上状态栏按 120 排完再被帧硬截，
  // 尾部的 PERMISSION 照样丢失。优先级机制在那种情况下根本没参与判断。
  width: widthOverride = null
}) {
  const width = Number(widthOverride ?? process.stdout.columns ?? 120) || 120
  const dense = width < 110
  const tight = width < 86
  const modelLabel = clipModel(model, tight ? 18 : dense ? 28 : 44)

  // 段落带优先级：拼不下时从**最不重要**的开始丢，而不是让终端从右边硬切。
  // 0.6.0 给 CONTEXT 加了绝对 token 数（宽约 6 字符），在 110 列的终端上
  // 恰好把 PERMISSION 挤出了边界 —— 被截掉的偏偏是「能不能不问就改文件」
  // 这个最该看见的信号。而 86 列下整条状态栏此前就已经溢出，属于既有缺陷。
  //
  // 0.8.1 起段先按 id 建好（built），再按 segmentOrder 选序 —— 配置决定
  // 「显示什么、什么顺序」，优先级机制继续决定「装不下丢什么」，两者正交。
  const built = {}
  const add = (id, text, priority = 5) => { built[id] = { text, priority } }
  // 颜色仍按航道取（theme.modes 的键是 0.3.x 航道名），标签用 0.4.0 的公开模式名
  const modeBg = theme.modes[mode] || theme.base.accent
  const modeInfo = modeId ? getMode(modeId) : null
  const modeLabel = modeInfo ? `${modeInfo.icon} ${modeInfo.label.toUpperCase()}` : String(mode).toUpperCase()
  add("mode", badge(modeLabel, contrastText(modeBg), modeBg), 0)
  add("model", badge(`MODEL ${modelLabel}`, theme.base.fg, theme.components.panel || theme.base.border, { bold: false }), 3)

  if (showTokenMeter && tokenMeter) {
    const t = tokenMeter.turn
    const s = tokenMeter.session
    const g = tokenMeter.global
    const tokenSegments = []
    if (aggregation.includes("turn")) tokenSegments.push(`T:${formatNumber(t.input + t.output)}`)
    if (!tight && aggregation.includes("session")) tokenSegments.push(`S:${formatNumber(s.input + s.output)}`)
    if (!dense && aggregation.includes("global")) tokenSegments.push(`G:${formatNumber(g.input + g.output)}`)
    const tokenText = `TOKENS ${tokenSegments.join(" ")}${tokenMeter.estimated ? " ~" : ""}`
    add("tokens", badge(tokenText, theme.base.fg, "#2d3748", { bold: false }))
  }
  if (showCost) {
    const savingsStr = savings > 0 ? ` ↓${formatCost(savings)}` : ""
    add("cost", badge(`COST ${formatCost(cost)}${savingsStr}`, contrastText(theme.semantic.warn), theme.semantic.warn, { bold: false }), 6)
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
      suffix = ` Cache:${hitPct}%`
    }
    // 绝对量比百分比更能回答「还剩多少」——193.4K (18%) 这种形式一眼可读。
    // tokens 缺失（早期帧）时退回纯百分比。
    const abs = Number(contextMeter.tokens) > 0 ? `${formatTokenCount(contextMeter.tokens)} ` : ""
    const text = tight ? `CTX ${pct}%` : `CONTEXT ${abs}(${pct}%)${suffix}`
    add("context", badge(text, contrastText(ctxBg), ctxBg, { bold: false }), 1)
  }
  if (memoryLoaded && !tight) {
    add("memory", badge("MEM", contrastText(theme.semantic.info), theme.semantic.info, { bold: false }), 7)
  }
  const permBg = permissionColor(permission, theme)
  add("permission", badge(`PERMISSION ${permission.toUpperCase()}`, contrastText(permBg), permBg, { bold: false }), 0)
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
      add("longagent", badge(`LONG ${parts.join(" ")}`, contrastText(theme.semantic.success), theme.semantic.success, { bold: false }), 2)
    }
  }

  const gap = layout === "comfortable" ? "  " : " "
  // 配置里没列的段不显示；列了但没建出来的（当前不适用/被 show_* 关掉）跳过
  const order = Array.isArray(segmentOrder) && segmentOrder.length ? segmentOrder : STATUS_SEGMENT_IDS
  const chosen = order.map((id) => built[id]).filter(Boolean)
  return fitSegments(chosen, width, gap)
}

/** SGR 序列不占屏幕宽度，量长度前必须剥掉 */
const SGR_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")

function visibleLength(text) {
  return String(text).replace(SGR_RE, "").length
}

/**
 * 按优先级装配：拼不下时从**优先级数字最大**的段开始丢。
 *
 * 此前是无脑 join 后交给调用方从右边硬截断 —— 于是最右边的段被牺牲，
 * 而顺序是历史形成的、与重要性无关。实测中 110 列的终端上被切掉的是
 * PERMISSION（「能不能不问就改文件」），为的是给一个装饰性的 token 数
 * 让位；86 列下整条状态栏更是本来就装不下。
 *
 * priority 0 的段（模式、权限）永不丢弃：它们装不下时宁可仍然溢出，
 * 也好过让人看不见自己处在什么权限档。
 */
export function fitSegments(segments, width, gap = " ") {
  const kept = segments.slice()
  const total = () => kept.reduce((n, s) => n + visibleLength(s.text), 0) + gap.length * Math.max(0, kept.length - 1)

  while (total() > width && kept.length > 1) {
    let worstIndex = -1
    let worstPriority = 0
    for (let i = 0; i < kept.length; i++) {
      if (kept[i].priority > worstPriority) {
        worstPriority = kept[i].priority
        worstIndex = i
      }
    }
    if (worstIndex < 0) break   // 只剩不可丢弃的段，接受溢出
    kept.splice(worstIndex, 1)
  }

  return kept.map((s) => s.text).join(gap)
}
