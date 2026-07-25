import { paint, isColorEnabled } from "./color.mjs"
import { DEFAULT_THEME } from "./default-theme.mjs"
import { highlightLine } from "./syntax-highlight.mjs"
import { sanitizeTerminalText } from "./terminal-sanitize.mjs"

/**
 * 0.6.0：配色改为从主题读取。此前这是个硬编码常量，与整个主题系统零关联 ——
 * 换主题时对话里的 markdown 纹丝不动。缺省值仍是原来那套，所以不传 theme
 * 的旧调用点行为不变。
 */
let COLORS = { ...DEFAULT_THEME.markdown }

export function setMarkdownColors(markdownTheme) {
  COLORS = { ...DEFAULT_THEME.markdown, ...(markdownTheme || {}) }
}

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g
const TOKEN_RE = /\uE000(\d+)\uE001/g
const ESCAPABLE_MARKDOWN = /\\([\\`*_[\]{}()#+\-.!|~>])/g

function strike(text) {
  // 删除线是手写 SGR 而非走 paint()，开关必须走同一个判定，否则
  // setColorEnabled 打开后其他元素上色、唯独删除线还是裸文本。
  if (!isColorEnabled()) return text
  return `\u001b[9m${text}\u001b[29m`
}

function sanitizeLinkTarget(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
}

function restoreTokens(text, tokens) {
  let restored = text
  // Nested formatting can leave a token inside another token's rendered value.
  for (let pass = 0; pass <= tokens.length; pass++) {
    let replaced = false
    restored = restored.replace(TOKEN_RE, (_, index) => {
      replaced = true
      return tokens[Number(index)] ?? ""
    })
    if (!replaced) break
  }
  return restored
}

function renderInline(text, depth = 0) {
  if (!text || depth > 12) return String(text || "")

  const tokens = []
  const hold = (value) => {
    const index = tokens.push(value) - 1
    return `\uE000${index}\uE001`
  }

  let rendered = String(text)

  // Protect escaped Markdown punctuation before recognizing any syntax.
  rendered = rendered.replace(ESCAPABLE_MARKDOWN, (_, literal) => hold(literal))

  // Code spans are opaque: Markdown markers inside them must never be parsed.
  rendered = rendered
    .replace(/\*\*`([^`\n]+)`\*\*/g, (_, code) => hold(paint(code, COLORS.code, { bold: true })))
    .replace(/__`([^`\n]+)`__/g, (_, code) => hold(paint(code, COLORS.code, { bold: true })))
    .replace(/`([^`\n]+)`/g, (_, code) => hold(paint(code, COLORS.code)))

  // Images and links become useful terminal text while retaining the target.
  rendered = rendered.replace(/!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (_, alt, rawTarget) => {
    const target = sanitizeLinkTarget(rawTarget)
    const label = alt ? renderInline(alt, depth + 1) : "image"
    return hold(`${paint("image:", COLORS.linkTarget, { dim: true })} ${label}${target ? paint(` (${target})`, COLORS.linkTarget, { dim: true }) : ""}`)
  })
  rendered = rendered.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (_, label, rawTarget) => {
    const target = sanitizeLinkTarget(rawTarget)
    const linkedLabel = paint(renderInline(label, depth + 1), COLORS.link, { underline: true })
    return hold(`${linkedLabel}${target ? paint(` (${target})`, COLORS.linkTarget, { dim: true }) : ""}`)
  })
  rendered = rendered.replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/gi, (_, rawTarget) => {
    const target = sanitizeLinkTarget(rawTarget)
    return hold(paint(target, COLORS.link, { underline: true }))
  })

  // Replace completed spans with opaque tokens so later expressions cannot
  // accidentally re-render Markdown characters inside already styled content.
  rendered = rendered
    .replace(/\*\*([^*\n]+)\*\*/g, (_, content) => hold(paint(content, COLORS.bold, { bold: true })))
    .replace(/__([^_\n]+)__/g, (_, content) => hold(paint(content, COLORS.bold, { bold: true })))
    .replace(/~~([^~\n]+)~~/g, (_, content) => hold(strike(content)))
    .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, (_, content) => hold(paint(content, COLORS.italic, { italic: true })))
    .replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, (_, content) => hold(paint(content, COLORS.italic, { italic: true })))

  return restoreTokens(rendered, tokens)
}

function renderLine(line) {
  const headingMatch = line.match(/^(#{1,6})\s+(.*)/)
  if (headingMatch) {
    const level = headingMatch[1].length
    const content = headingMatch[2]
    const indent = level > 1 ? "  ".repeat(level - 1) : ""
    // h1/h2/h3+ 分层色差：原先六级同色，层级结构只能靠缩进看
    const headingColor = level === 1 ? COLORS.heading1 : level === 2 ? COLORS.heading2 : COLORS.heading3
    return `${indent}${paint(renderInline(content), headingColor, { bold: level <= 2 })}`
  }

  if (line.trimStart().startsWith("> ")) {
    const content = line.replace(/^\s*>\s?/, "")
    return paint(`\u2502 ${renderInline(content)}`, COLORS.quote)
  }

  const taskMatch = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)/)
  if (taskMatch) {
    const done = taskMatch[2].toLowerCase() === "x"
    const marker = paint(done ? "\u2611" : "\u2610", done ? COLORS.taskDone : COLORS.listMarker)
    const content = renderInline(taskMatch[3])
    return `${taskMatch[1]}${marker} ${done ? paint(content, null, { dim: true }) : content}`
  }

  const ulMatch = line.match(/^(\s*)([-*+])\s+(.*)/)
  if (ulMatch) {
    return `${ulMatch[1]}${paint("\u2022", COLORS.listMarker)} ${renderInline(ulMatch[3])}`
  }

  // 水平线此前完全不识别，`---` 会被当成普通正文原样输出
  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
    return paint("─".repeat(Math.min(60, Math.max(10, line.trim().length * 3))), COLORS.rule)
  }

  const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)/)
  if (olMatch) {
    return `${olMatch[1]}${paint(`${olMatch[2]}.`, COLORS.listMarker)} ${renderInline(olMatch[3])}`
  }

  return renderInline(line)
}

function parseFenceStart(line) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
  if (!match) return null
  return {
    marker: match[1][0],
    length: match[1].length,
    language: match[2].trim()
  }
}

function isFenceEnd(line, fence) {
  if (!fence) return false
  const match = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/)
  return Boolean(match && match[1][0] === fence.marker && match[1].length >= fence.length)
}

function renderFenceStart(language) {
  const label = language ? ` ${language} ` : ""
  return paint(`\u2500\u2500\u2500${label}${"".padEnd(Math.max(0, 40 - label.length), "\u2500")}`, COLORS.codeFence)
}

function renderFenceEnd() {
  return paint("\u2500".repeat(43), COLORS.codeFence)
}

function splitTableRow(line) {
  const source = String(line || "").trim()
  if (!source.includes("|")) return null

  const cells = []
  let cell = ""
  let escaped = false
  let inCode = false
  let foundSeparator = false

  for (const char of source) {
    if (escaped) {
      cell += char
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      cell += char
      continue
    }
    if (char === "`") {
      inCode = !inCode
      cell += char
      continue
    }
    if (char === "|" && !inCode) {
      cells.push(cell.trim())
      cell = ""
      foundSeparator = true
      continue
    }
    cell += char
  }
  if (escaped) cell += "\\"
  cells.push(cell.trim())

  if (!foundSeparator) return null
  if (source.startsWith("|")) cells.shift()
  if (source.endsWith("|") && cells.at(-1) === "") cells.pop()
  if (cells.length < 2) return null
  return cells.map((value) => value.replace(/\\\|/g, "|"))
}

function parseTableDelimiter(line) {
  const cells = splitTableRow(line)
  if (!cells) return null
  const alignments = []
  for (const cell of cells) {
    const compact = cell.replace(/\s/g, "")
    if (!/^:?-{3,}:?$/.test(compact)) return null
    const left = compact.startsWith(":")
    const right = compact.endsWith(":")
    alignments.push(left && right ? "center" : right ? "right" : "left")
  }
  return alignments
}

function isFullWidthCodePoint(code) {
  return (
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
  )
}

function displayWidth(text) {
  let width = 0
  for (const char of String(text || "").replace(ANSI_RE, "")) {
    const code = char.codePointAt(0)
    if (/\p{Mark}/u.test(char)) continue
    width += isFullWidthCodePoint(code) ? 2 : 1
  }
  return width
}

function padTableCell(text, width, alignment) {
  const missing = Math.max(0, width - displayWidth(text))
  if (alignment === "right") return `${" ".repeat(missing)}${text}`
  if (alignment === "center") {
    const left = Math.floor(missing / 2)
    return `${" ".repeat(left)}${text}${" ".repeat(missing - left)}`
  }
  return `${text}${" ".repeat(missing)}`
}

function renderTable(header, delimiter, rows) {
  const renderedRows = [header.cells, ...rows.map((row) => row.cells)]
    .map((cells) => cells.map((cell) => renderInline(cell)))
  const widths = header.cells.map((_, column) => (
    Math.max(3, ...renderedRows.map((row) => displayWidth(row[column] || "")))
  ))
  const border = (value) => paint(value, COLORS.tableBorder)
  const renderRow = (cells, headerRow = false) => {
    const content = cells.map((cell, column) => {
      const value = headerRow ? paint(cell, COLORS.tableHeader, { bold: true }) : cell
      return ` ${padTableCell(value, widths[column], delimiter.alignments[column])} `
    })
    return `${border("\u2502")}${content.join(border("\u2502"))}${border("\u2502")}`
  }
  const separator = `${border("\u251c")}${widths.map((width) => "\u2500".repeat(width + 2)).join(border("\u253c"))}${border("\u2524")}`

  return [
    { text: renderRow(renderedRows[0], true), terminated: header.terminated },
    { text: separator, terminated: delimiter.terminated },
    ...renderedRows.slice(1).map((cells, index) => ({
      text: renderRow(cells),
      terminated: rows[index].terminated
    }))
  ]
}

function appendRecord(output, text, terminated) {
  output.push(text)
  if (terminated) output.push("\n")
}

export function renderMarkdown(text) {
  if (!text) return ""
  const lines = sanitizeTerminalText(text).split("\n")
  const out = []
  let fence = null

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]

    if (fence) {
      if (isFenceEnd(line, fence)) {
        out.push(renderFenceEnd())
        fence = null
      } else {
        out.push(`  ${highlightLine(line, fence.language, COLORS) || paint(line, COLORS.codeBlock)}`)
      }
      continue
    }

    const fenceStart = parseFenceStart(line)
    if (fenceStart) {
      fence = fenceStart
      out.push(renderFenceStart(fenceStart.language))
      continue
    }

    const headerCells = splitTableRow(line)
    const alignments = index + 1 < lines.length ? parseTableDelimiter(lines[index + 1]) : null
    if (headerCells && alignments && headerCells.length === alignments.length) {
      const rows = []
      let next = index + 2
      while (next < lines.length) {
        const cells = splitTableRow(lines[next])
        if (!cells || cells.length !== headerCells.length) break
        rows.push({ cells, terminated: false })
        next++
      }
      const table = renderTable(
        { cells: headerCells, terminated: false },
        { alignments, terminated: false },
        rows
      )
      out.push(...table.map((record) => record.text))
      index = next - 1
      continue
    }

    out.push(renderLine(line))
  }
  return out.join("\n")
}

export function createStreamRenderer() {
  let buffer = ""
  let fence = null
  let tableCandidate = null
  let table = null

  function emitTable(output) {
    if (!table) return
    for (const record of renderTable(table.header, table.delimiter, table.rows)) {
      appendRecord(output, record.text, record.terminated)
    }
    table = null
  }

  function handleRecord(record, output) {
    if (fence) {
      if (isFenceEnd(record.line, fence)) {
        appendRecord(output, renderFenceEnd(), record.terminated)
        fence = null
      } else {
        appendRecord(output, paint(`  ${record.line}`, COLORS.codeBlock), record.terminated)
      }
      return
    }

    if (table) {
      const cells = splitTableRow(record.line)
      if (cells && cells.length === table.header.cells.length) {
        table.rows.push({ ...record, cells })
        return
      }
      emitTable(output)
      handleRecord(record, output)
      return
    }

    if (tableCandidate) {
      const alignments = parseTableDelimiter(record.line)
      if (alignments && alignments.length === tableCandidate.cells.length) {
        table = {
          header: tableCandidate,
          delimiter: { ...record, alignments },
          rows: []
        }
        tableCandidate = null
        return
      }
      appendRecord(output, renderLine(tableCandidate.line), tableCandidate.terminated)
      tableCandidate = null
    }

    const fenceStart = parseFenceStart(record.line)
    if (fenceStart) {
      fence = fenceStart
      appendRecord(output, renderFenceStart(fenceStart.language), record.terminated)
      return
    }

    const cells = splitTableRow(record.line)
    if (cells) {
      tableCandidate = { ...record, cells }
      return
    }
    appendRecord(output, renderLine(record.line), record.terminated)
  }

  function drainRecords(output, { holdTrailingCarriageReturn = true } = {}) {
    while (buffer) {
      const match = /(?:\r\n|\r|\n)/.exec(buffer)
      if (!match) break
      if (
        holdTrailingCarriageReturn
        && match[0] === "\r"
        && match.index === buffer.length - 1
      ) {
        break
      }
      const line = sanitizeTerminalText(buffer.slice(0, match.index))
      buffer = buffer.slice(match.index + match[0].length)
      handleRecord({ line, terminated: true }, output)
    }
  }

  function push(chunk) {
    buffer += String(chunk ?? "")
    const output = []
    drainRecords(output)
    return output.join("")
  }

  function flush() {
    const output = []
    drainRecords(output, { holdTrailingCarriageReturn: false })
    if (buffer) {
      handleRecord({ line: sanitizeTerminalText(buffer), terminated: false }, output)
    }
    buffer = ""

    if (table) emitTable(output)
    if (tableCandidate) {
      appendRecord(output, renderLine(tableCandidate.line), tableCandidate.terminated)
      tableCandidate = null
    }

    fence = null
    return output.join("")
  }

  return { push, flush }
}
