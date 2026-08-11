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
  for (let sourceIndex = 0; sourceIndex < logs.length; sourceIndex++) {
    const value = logs[sourceIndex]
    if (isTranscriptItem(value)) {
      const sectionCounts = new Map()
      for (const rendered of renderTranscriptItems([value], { paint, theme })) {
        const section = rendered.section || "line"
        const logicalLineIndex = sectionCounts.get(section) || 0
        sectionCounts.set(section, logicalLineIndex + 1)
        lines.push({ ...rendered, sourceIndex, section, logicalLineIndex })
      }
      continue
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      lines.push({
        ...value,
        text: String(value.text ?? ""),
        itemId: value.itemId ?? value.id ?? null,
        sourceIndex,
        section: value.section || "line",
        logicalLineIndex: Number.isInteger(value.logicalLineIndex) ? value.logicalLineIndex : 0,
        clickable: Boolean(value.clickable),
        action: value.action || null
      })
      continue
    }
    lines.push({
      text: String(value ?? ""),
      itemId: null,
      sourceIndex,
      section: "line",
      logicalLineIndex: 0,
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

function lineAnchor(line, viewportRow) {
  return {
    itemId: line.itemId ?? null,
    sourceIndex: line.sourceIndex,
    section: line.section || "line",
    logicalLineIndex: Number(line.logicalLineIndex) || 0,
    wrappedIndex: Number(line.wrappedIndex) || 0,
    viewportRow
  }
}

function sameLogicalLine(line, anchor) {
  const sameOwner = anchor.itemId !== null
    ? line.itemId === anchor.itemId
    : line.itemId == null && line.sourceIndex === anchor.sourceIndex
  return sameOwner
    && (line.section || "line") === anchor.section
    && (Number(line.logicalLineIndex) || 0) === anchor.logicalLineIndex
}

function findAnchorIndex(lines, anchor) {
  let nearest = -1
  let nearestDistance = Infinity
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!sameLogicalLine(line, anchor)) continue
    const wrappedIndex = Number(line.wrappedIndex) || 0
    if (wrappedIndex === anchor.wrappedIndex) return index
    const distance = Math.abs(wrappedIndex - anchor.wrappedIndex)
    if (distance < nearestDistance) {
      nearest = index
      nearestDistance = distance
    }
  }
  return nearest
}

function offsetForPreviousAnchor(lines, previousScrollMeta, logRows) {
  const candidates = Array.isArray(previousScrollMeta?.anchorCandidates)
    ? previousScrollMeta.anchorCandidates
    : []
  for (const anchor of candidates) {
    const index = findAnchorIndex(lines, anchor)
    if (index < 0) continue
    const desiredStart = Math.max(0, index - Math.max(0, Number(anchor.viewportRow) || 0))
    return Math.max(0, lines.length - desiredStart - logRows)
  }
  return null
}

export function buildTranscriptViewport({
  logs = [],
  width,
  logRows,
  scrollOffset,
  // 上一帧的 scrollMeta。它保存可见行的稳定身份，而不只是总行数：
  // 展开/折叠、streaming 重排、resize 都会改变 totalRows，只看差值会锚错位置。
  previousScrollMeta = null,
  wrapLogLines,
  clipAnsiLine,
  paint,
  theme
}) {
  const sourceLines = toLineMetadata(logs, { paint, theme })
  const wrappedAllLineMeta = wrapMetadataLines(sourceLines, width, wrapLogLines)
  let anchoredOffset = scrollOffset
  const sameUserOffset = Number.isFinite(previousScrollMeta?.scrollOffset)
    && previousScrollMeta.scrollOffset === scrollOffset
  if (scrollOffset > 0 && sameUserOffset) {
    const resolved = offsetForPreviousAnchor(wrappedAllLineMeta, previousScrollMeta, logRows)
    if (resolved !== null) anchoredOffset = resolved
    else if (
      previousScrollMeta.width === width &&
      Number.isFinite(previousScrollMeta.totalRows) &&
      wrappedAllLineMeta.length > previousScrollMeta.totalRows
    ) {
      // 无 itemId 的旧式纯文本才退回总行数差；仅处理尾部增长。
      anchoredOffset += wrappedAllLineMeta.length - previousScrollMeta.totalRows
    }
  }
  const maxOffset = Math.max(0, wrappedAllLineMeta.length - logRows)
  const clampedOffset = Math.max(0, Math.min(maxOffset, anchoredOffset))
  const end = Math.max(0, wrappedAllLineMeta.length - clampedOffset)
  const start = Math.max(0, end - logRows)
  const visibleLineMeta = wrappedAllLineMeta.slice(start, end)
  const wrappedLogs = visibleLineMeta.map((line) => line.text)
  const scrollMeta = {
    logRows,
    totalRows: wrappedAllLineMeta.length,
    maxOffset,
    width,
    scrollOffset: clampedOffset,
    anchorCandidates: visibleLineMeta.map((line, viewportRow) => lineAnchor(line, viewportRow))
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
