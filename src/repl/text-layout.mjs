const ANSI_SEQUENCE_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-_])/g
const ANSI_AT_START_RE = /^\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-_])/
const RESET_RE = /^\x1b\[(?:0)?m$/
const graphemeSegmenter = typeof Intl?.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null

export function stripTerminalAnsi(value) {
  ANSI_SEQUENCE_RE.lastIndex = 0
  return String(value || "").replace(ANSI_SEQUENCE_RE, "")
}

function isCombiningCodePoint(code) {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f) ||
    code === 0x200d ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0100 && code <= 0xe01ef)
  )
}

function isWideCodePoint(code) {
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
      (code >= 0x1f000 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd)
    )
  )
}

export function splitGraphemes(value) {
  const text = String(value || "")
  if (!text) return []
  if (graphemeSegmenter) {
    return Array.from(graphemeSegmenter.segment(text), (part) => ({
      text: part.segment,
      index: part.index,
      end: part.index + part.segment.length
    }))
  }
  let index = 0
  return Array.from(text, (part) => {
    const entry = { text: part, index, end: index + part.length }
    index += part.length
    return entry
  })
}

export function terminalCellWidth(value) {
  const text = stripTerminalAnsi(value)
  let width = 0
  for (const cluster of splitGraphemes(text)) {
    if (cluster.text === "\n" || cluster.text === "\r") continue
    const points = Array.from(cluster.text, (character) => character.codePointAt(0))
    if (points.some((code) =>
      code === 0x200d ||
      code === 0xfe0f ||
      code === 0x20e3 ||
      (code >= 0x1f000 && code <= 0x1faff)
    )) {
      width += 2
      continue
    }
    let clusterWidth = 0
    for (const code of points) {
      if (code < 0x20 || (code >= 0x7f && code < 0xa0) || isCombiningCodePoint(code)) continue
      clusterWidth += isWideCodePoint(code) ? 2 : 1
    }
    width += Math.max(0, clusterWidth)
  }
  return width
}

function visibleInputCluster(value, column, tabWidth = 4) {
  const text = String(value || "")
  if (text === "\t") {
    const count = Math.max(1, tabWidth - (column % tabWidth))
    return " ".repeat(count)
  }
  let output = ""
  for (const character of text) {
    const code = character.codePointAt(0)
    if (code < 0x20) {
      output += String.fromCodePoint(0x2400 + code)
    } else if (code === 0x7f) {
      output += "\u2421"
    } else if (code >= 0x80 && code <= 0x9f) {
      output += "\ufffd"
    } else {
      output += character
    }
  }
  return output
}

function tokenizeAnsi(value) {
  const source = String(value || "")
  const tokens = []
  let offset = 0
  while (offset < source.length) {
    if (source[offset] === "\x1b") {
      const match = source.slice(offset).match(ANSI_AT_START_RE)
      if (match) {
        tokens.push({ type: "ansi", text: match[0] })
        offset += match[0].length
        continue
      }
    }
    const nextEscape = source.indexOf("\x1b", offset)
    const end = nextEscape === -1 ? source.length : nextEscape
    const plain = source.slice(offset, end)
    for (const segment of splitGraphemes(plain)) {
      tokens.push({ type: "text", text: segment.text, width: terminalCellWidth(segment.text) })
    }
    offset = end
  }
  return tokens
}

function nextStyle(style, sequence) {
  if (!sequence.endsWith("m")) return style
  if (RESET_RE.test(sequence)) return ""
  return style + sequence
}

export function wrapAnsiLine(value, width) {
  const maxWidth = Math.max(1, Math.trunc(width || 1))
  const lines = []
  let line = ""
  let cells = 0
  let style = ""

  const pushLine = () => {
    lines.push(style ? `${line}\x1b[0m` : line)
    line = style
    cells = 0
  }

  for (const token of tokenizeAnsi(value)) {
    if (token.type === "ansi") {
      line += token.text
      style = nextStyle(style, token.text)
      continue
    }
    if (token.text === "\r") continue
    if (token.text === "\n") {
      pushLine()
      continue
    }
    if (token.width > 0 && cells > 0 && cells + token.width > maxWidth) pushLine()
    line += token.text
    cells += token.width
  }
  lines.push(style ? `${line}\x1b[0m` : line)
  return lines.length ? lines : [""]
}

export function clipAnsiByWidth(value, width) {
  const maxWidth = Math.max(0, Math.trunc(width || 0))
  if (maxWidth === 0) return ""
  const wrapped = wrapAnsiLine(value, maxWidth)
  return wrapped[0] || ""
}

function normalizeCursor(value, cursor) {
  const text = String(value || "")
  const target = Math.max(0, Math.min(text.length, Number(cursor) || 0))
  const boundaries = [0, ...splitGraphemes(text).map((part) => part.end)]
  let best = 0
  for (const boundary of boundaries) {
    if (boundary > target) break
    best = boundary
  }
  return best
}

export function moveGraphemeCursor(value, cursor, delta) {
  const text = String(value || "")
  const boundaries = [0, ...splitGraphemes(text).map((part) => part.end)]
  const normalized = normalizeCursor(text, cursor)
  const current = Math.max(0, boundaries.indexOf(normalized))
  const next = Math.max(0, Math.min(boundaries.length - 1, current + Math.sign(delta || 0)))
  return boundaries[next]
}

/**
 * 把一段文本换成等长（按**字素簇**计）的遮蔽串，并给出遮蔽串里的光标位置。
 *
 * 遮蔽必须停留在**渲染层**：真值仍然存在 `ui.questionCustomInput` 里，编辑键
 * （左右、Backspace、插入）照旧作用在真值上。这里只回答一个问题 ——「这段真值
 * 画出来是什么、光标画在第几格」。
 *
 * 逐字素簇替换而不是 `"•".repeat(text.length)`：后者会按 UTF-16 码元数出格子，
 * 一个 emoji 或一个带组合符的字会多画出好几个点，光标当场错位。返回的
 * `normalizedCursor` 是**真值坐标系**里对齐到簇边界的光标，调用方回写它即可，
 * 不会把遮蔽串的下标写回真值。
 */
export function maskSecretText(value, cursor, maskChar = "•") {
  const text = String(value || "")
  const normalizedCursor = normalizeCursor(text, cursor)
  let masked = ""
  let maskedCursor = 0
  for (const cluster of splitGraphemes(text)) {
    if (cluster.end <= normalizedCursor) maskedCursor += maskChar.length
    masked += maskChar
  }
  return { value: masked, cursor: maskedCursor, normalizedCursor }
}

export function layoutInputText({
  value = "",
  cursor = 0,
  width = 80,
  maxRows = 5,
  prefix = "",
  selection = null,
  ghost = ""
} = {}) {
  const text = String(value || "")
  const innerWidth = Math.max(1, Math.trunc(width || 1))
  const safeCursor = normalizeCursor(text, cursor)
  const rows = [{ text: String(prefix || ""), cells: [], endIndex: 0 }]
  let rowIndex = 0
  let column = terminalCellWidth(prefix)
  let cursorPosition = safeCursor === 0 ? { row: 0, col: column } : null
  const selectedStart = Math.min(selection?.start ?? -1, selection?.end ?? -1)
  const selectedEnd = Math.max(selection?.start ?? -1, selection?.end ?? -1)

  for (const segment of splitGraphemes(text)) {
    if (segment.text === "\r") continue
    if (segment.text === "\n") {
      if (safeCursor === segment.index) cursorPosition = { row: rowIndex, col: column }
      rows[rowIndex].endIndex = segment.index
      rows.push({ text: "", cells: [], endIndex: segment.end })
      rowIndex += 1
      column = 0
      if (safeCursor === segment.end) cursorPosition = { row: rowIndex, col: 0 }
      continue
    }

    const visibleText = visibleInputCluster(segment.text, column)
    const cellWidth = Math.max(0, terminalCellWidth(visibleText))
    if (column > 0 && cellWidth > 0 && column + cellWidth > innerWidth) {
      rows[rowIndex].endIndex = segment.index
      rows.push({ text: "", cells: [], endIndex: segment.index })
      rowIndex += 1
      column = 0
    }
    if (safeCursor === segment.index) cursorPosition = { row: rowIndex, col: column }

    const selected = selectedStart >= 0 && segment.index >= selectedStart && segment.end <= selectedEnd
    const rendered = selected ? `\x1b[7m${visibleText}\x1b[27m` : visibleText
    rows[rowIndex].text += rendered
    rows[rowIndex].cells.push({
      startCol: column,
      endCol: column + Math.max(1, cellWidth),
      startIndex: segment.index,
      endIndex: segment.end
    })
    column += cellWidth
    rows[rowIndex].endIndex = segment.end
    if (safeCursor === segment.end) cursorPosition = { row: rowIndex, col: column }
  }

  // A terminal cursor cannot safely occupy the cell immediately after a
  // completely full row because that is where the composer border is drawn.
  // Materialize the implicit wrapped row when the cursor is at end-of-input.
  if (
    safeCursor === text.length &&
    cursorPosition?.row === rowIndex &&
    cursorPosition.col >= innerWidth
  ) {
    rows[rowIndex].endIndex = text.length
    rows.push({ text: "", cells: [], endIndex: text.length })
    rowIndex += 1
    cursorPosition = { row: rowIndex, col: 0 }
  }

  if (!cursorPosition) cursorPosition = { row: rowIndex, col: column }

  // Ghost text（下一句预测）只在光标处于输入末尾时显示，且刻意不进入
  // cells、不改 cursorPosition、不改 endIndex —— 它是纯视觉提示，鼠标
  // 点击与光标计算都必须看不见它。超出本行剩余宽度的部分直接裁掉，
  // 保证不产生新行，行数与无 ghost 时完全一致。
  const ghostText = String(ghost || "")
  if (ghostText && safeCursor === text.length) {
    const remaining = innerWidth - cursorPosition.col
    if (remaining > 1) {
      const clipped = clipAnsiByWidth(ghostText.replace(/[\r\n]+/g, " "), remaining)
      if (clipped) rows[cursorPosition.row].text += `\x1b[90m${clipped}\x1b[0m`
    }
  }

  const visibleCount = Math.max(1, Math.trunc(maxRows || 1))
  const viewportStart = Math.max(0, cursorPosition.row - visibleCount + 1)
  const visibleRows = rows.slice(viewportStart, viewportStart + visibleCount)

  return {
    lines: visibleRows.map((row) => row.text),
    rows: visibleRows,
    viewportStart,
    cursor: {
      row: cursorPosition.row - viewportStart,
      col: cursorPosition.col
    },
    normalizedCursor: safeCursor
  }
}

export function inputIndexAtPosition(layout, row, col) {
  const targetRow = layout?.rows?.[Math.max(0, Math.trunc(row || 0))]
  if (!targetRow) return 0
  const targetCol = Math.max(0, Number(col) || 0)
  if (!targetRow.cells.length) return targetRow.endIndex || 0
  for (const cell of targetRow.cells) {
    const midpoint = cell.startCol + (cell.endCol - cell.startCol) / 2
    if (targetCol < midpoint) return cell.startIndex
    if (targetCol < cell.endCol) return cell.endIndex
  }
  return targetRow.endIndex
}

export function splitTextByCellRange(value, startCell, endCell) {
  const text = stripTerminalAnsi(value)
  const start = Math.max(0, Number(startCell) || 0)
  const end = Math.max(start, Number(endCell) || 0)
  let cells = 0
  let startIndex = text.length
  let endIndex = text.length
  let foundStart = false
  let foundEnd = false

  for (const segment of splitGraphemes(text)) {
    const nextCells = cells + terminalCellWidth(segment.text)
    if (!foundStart && start < nextCells) {
      startIndex = segment.index
      foundStart = true
    }
    if (end <= cells) {
      endIndex = segment.index
      foundEnd = true
      break
    }
    cells = nextCells
  }
  if (!foundStart && start <= cells) startIndex = text.length
  if (!foundEnd && end >= cells) endIndex = text.length

  return {
    before: text.slice(0, startIndex),
    selected: text.slice(startIndex, Math.max(startIndex, endIndex)),
    after: text.slice(Math.max(startIndex, endIndex))
  }
}
