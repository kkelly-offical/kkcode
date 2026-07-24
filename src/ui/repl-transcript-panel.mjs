import { renderTranscriptItems } from "./transcript-model.mjs"

function isTranscriptItem(value) {
  return Boolean(
    value
    && typeof value === "object"
    && (
      Object.prototype.hasOwnProperty.call(value, "summary")
      || Object.prototype.hasOwnProperty.call(value, "details")
      || Object.prototype.hasOwnProperty.call(value, "title")
    )
  )
}

function toLineMetadata(logs, { paint, theme }) {
  const lines = []
  for (const value of logs) {
    if (isTranscriptItem(value)) {
      lines.push(...renderTranscriptItems([value], { paint, theme }))
      continue
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      lines.push({
        ...value,
        text: String(value.text ?? ""),
        itemId: value.itemId ?? value.id ?? null,
        clickable: Boolean(value.clickable),
        action: value.action || null
      })
      continue
    }
    lines.push({
      text: String(value ?? ""),
      itemId: null,
      clickable: false,
      action: null
    })
  }
  return lines
}

function wrapMetadataLines(lines, width, wrapLogLines) {
  const wrapped = []
  for (const line of lines) {
    const parts = wrapLogLines([line.text], width)
    const safeParts = Array.isArray(parts) && parts.length > 0 ? parts : [""]
    for (let index = 0; index < safeParts.length; index++) {
      wrapped.push({
        ...line,
        text: String(safeParts[index] ?? ""),
        wrappedIndex: index
      })
    }
  }
  return wrapped
}

export function buildTranscriptViewport({
  logs = [],
  width,
  logRows,
  scrollOffset,
  wrapLogLines,
  clipAnsiLine,
  paint,
  theme
}) {
  const sourceLines = toLineMetadata(logs, { paint, theme })
  const wrappedAllLineMeta = wrapMetadataLines(sourceLines, width, wrapLogLines)
  const maxOffset = Math.max(0, wrappedAllLineMeta.length - logRows)
  const clampedOffset = Math.max(0, Math.min(maxOffset, scrollOffset))
  const end = Math.max(0, wrappedAllLineMeta.length - clampedOffset)
  const start = Math.max(0, end - logRows)
  const visibleLineMeta = wrappedAllLineMeta.slice(start, end)
  const wrappedLogs = visibleLineMeta.map((line) => line.text)
  const scrollMeta = {
    logRows,
    totalRows: wrappedAllLineMeta.length,
    maxOffset
  }

  const scrollHint = clampedOffset > 0
    ? paint(`  Ctrl+Up/Down scroll | +${clampedOffset} lines`, theme.semantic.warn)
    : paint("  Ctrl+Up/Down scroll | Ctrl+Home oldest | Ctrl+End latest", theme.base.muted, { dim: true })

  const totalLog = wrappedAllLineMeta.length
  const showScrollbar = totalLog > logRows
  let thumbStart = 0
  let thumbEnd = 0
  if (showScrollbar) {
    thumbStart = Math.floor((start / totalLog) * logRows)
    thumbEnd = Math.min(logRows, thumbStart + Math.max(1, Math.round((logRows / totalLog) * logRows)))
  }

  const lines = []
  const hitRegions = []
  for (let i = 0; i < logRows; i++) {
    const content = wrappedLogs[i] || ""
    const lineMeta = visibleLineMeta[i] || null
    if (showScrollbar) {
      const bar = i >= thumbStart && i < thumbEnd
        ? paint("┃", theme.semantic.warn)
        : paint("│", theme.base.border, { dim: true })
      lines.push(clipAnsiLine(content, width - 2) + " " + bar)
    } else {
      lines.push(clipAnsiLine(content, width))
    }
    if (lineMeta?.clickable && lineMeta.itemId) {
      const contentWidth = Math.max(1, showScrollbar ? width - 2 : width)
      hitRegions.push({
        row: i + 1,
        viewportRow: i,
        columnStart: 1,
        columnEnd: contentWidth,
        itemId: lineMeta.itemId,
        action: lineMeta.action || "toggle",
        section: lineMeta.section || null
      })
    }
  }

  return {
    lines,
    scrollHint,
    scrollMeta,
    scrollOffset: clampedOffset,
    wrappedLogs,
    visibleLineMeta,
    hitRegions,
    clickableRegions: hitRegions,
    // 视口首行在完整 transcript 里的绝对行号。拖选跨滚动时必须把屏幕行
    // 换算成绝对行，否则滚动一次锚点就指向了别的内容。
    visibleStartIndex: start,
    // 全部换行后的纯文本，供选区跨滚动取文本用
    allLines: wrappedAllLineMeta.map((line) => line.text)
  }
}
