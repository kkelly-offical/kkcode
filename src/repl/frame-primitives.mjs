import { paint } from "../theme/color.mjs"
import {
  stripTerminalAnsi,
  splitGraphemes,
  terminalCellWidth,
  wrapAnsiLine,
  clipAnsiByWidth
} from "./text-layout.mjs"

/**
 * 帧绘制的度量与拼装原语。
 *
 * 抽出来的理由不是 repl.mjs 太长，而是**这些函数此前有五份互不一致的副本**，
 * 而它们量的是同一件事：一段带颜色的文本在终端里占几个单元格。
 *
 *   repl.mjs            `/\x1B\[[0-9;]*m/g`                     只认 SGR
 *   repl-dashboard.mjs  同上                                     只认 SGR
 *   activity-renderer   `\x1B(?:[@-Z\\-_]|\[…|\][^\x07]*\x07)`   OSC 只认 BEL 结尾
 *   text-layout.mjs     再加 ST 结尾的 OSC                        最完整
 *   repl-help.mjs       `value.length`                          既不剥 ANSI 也不算宽字符
 *
 * 后果分两类。一类已经在发生：`padRight` 先用只认 SGR 的正则剥一遍，再把结果
 * 当纯文本填进帧格 —— 于是工具输出里的 OSC 超链接（npm/pnpm 会输出）或光标
 * 序列会带着转义字节进入帧，绘制时终端会真的去执行那个指令。另一类是潜在的：
 * repl-help 的 `padRight` 按 JS 字符串长度对齐，一个中文界面里只要有一行含
 * 中文就会错位 4 格 —— 它今天没发作，只因为帮助表的第一列恰好全是 ASCII 命令。
 *
 * 所以这里只保留一份实现，统一走 text-layout 的宽剥离与单元格宽度。
 */

/** 剥掉所有终端转义序列（SGR、CSI、OSC，OSC 的 BEL 与 ST 两种结尾都认）。 */
export function stripAnsi(text) {
  return stripTerminalAnsi(text)
}

/** 文本在终端里占的单元格数。CJK 与 emoji 按 2 算，组合字符按 0 算。 */
export function displayWidth(text) {
  return terminalCellWidth(text)
}

/** 按单元格宽度裁剪纯文本，不切断字素簇。 */
export function clipPlainByWidth(text, maxWidth) {
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

/**
 * 补齐到指定单元格宽度。返回的是**纯文本**（颜色码已剥离）—— 调用方若需要
 * 保留颜色，用 clipAnsiLine。
 */
export function padRight(text, width) {
  const raw = stripAnsi(text)
  const used = displayWidth(raw)
  if (used < width) return raw + " ".repeat(width - used)
  // 裁剪可能落在宽字符中间：clipPlainByWidth 不切开字素簇，所以宁可少一格。
  // 那一格必须补回来 —— 否则这个单元格窄一格，整行后续内容全部左移，
  // 表现为「边框错位」，而且只在内容含 CJK/emoji 时出现。
  const clipped = clipPlainByWidth(raw, width)
  return clipped + " ".repeat(Math.max(0, width - displayWidth(clipped)))
}

/**
 * 把一行裁到指定宽度并补齐，**保留颜色码**。超宽时末位换成 `~` 以示截断。
 */
export function clipAnsiLine(text, width) {
  const raw = stripAnsi(text)
  const used = displayWidth(raw)
  if (used <= width) return `${String(text || "")}${" ".repeat(Math.max(0, width - used))}`
  if (width <= 1) {
    const tight = clipAnsiByWidth(text, Math.max(0, width))
    return tight + " ".repeat(Math.max(0, width - displayWidth(tight)))
  }
  // 同上：宽字符导致裁剪结果比 width-1 更窄时，补足到 width。
  // frameRow 用它填边框内部，少一格就是边框对不齐。
  const body = `${clipAnsiByWidth(text, width - 1)}~`
  return body + " ".repeat(Math.max(0, width - displayWidth(body)))
}

/** 按宽度硬折一行纯文本（不断词）。 */
export function wrapPlainLine(text, width) {
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

/**
 * 折多行日志，保留颜色。maxRows 给定时**保留末尾**若干行 —— 日志的关键信息
 * 在最后，截头比截尾有用。
 */
export function wrapLogLines(lines, width, maxRows = null) {
  const wrapped = []
  for (const line of lines) {
    for (const part of wrapAnsiLine(line, width)) wrapped.push(part)
  }
  if (!Number.isInteger(maxRows) || maxRows < 0) return wrapped
  if (wrapped.length <= maxRows) return wrapped
  return wrapped.slice(wrapped.length - maxRows)
}

export function frameTop(width, color) {
  return paint(`┌${"─".repeat(Math.max(1, width - 2))}┐`, color)
}

export function frameBottom(width, color) {
  return paint(`└${"─".repeat(Math.max(1, width - 2))}┘`, color)
}

export function frameDivider(width, color) {
  return paint(`├${"─".repeat(Math.max(1, width - 2))}┤`, color)
}

export function frameRow(content, width, color) {
  const inner = Math.max(1, width - 4)
  return `${paint("│ ", color)}${clipAnsiLine(content, inner)}${paint(" │", color)}`
}

/** 滚动一页翻多少行。留 25% 重叠，翻页后仍能看到上下文。 */
const SCROLL_PAGE_RATIO = 0.75

export function pageSize(rows) {
  return Math.max(1, Math.floor(rows * SCROLL_PAGE_RATIO))
}

export function ageLabel(ms) {
  const mins = Math.round(ms / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}
