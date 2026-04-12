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
  const wrappedAllLogs = wrapLogLines(logs, width)
  const maxOffset = Math.max(0, wrappedAllLogs.length - logRows)
  const clampedOffset = Math.max(0, Math.min(maxOffset, scrollOffset))
  const end = Math.max(0, wrappedAllLogs.length - clampedOffset)
  const start = Math.max(0, end - logRows)
  const wrappedLogs = wrappedAllLogs.slice(start, end)
  const scrollMeta = {
    logRows,
    totalRows: wrappedAllLogs.length,
    maxOffset
  }

  const scrollHint = clampedOffset > 0
    ? paint(`  Ctrl+Up/Down scroll | +${clampedOffset} lines`, theme.semantic.warn)
    : paint("  Ctrl+Up/Down scroll | Ctrl+Home oldest | Ctrl+End latest", theme.base.muted, { dim: true })

  const totalLog = wrappedAllLogs.length
  const showScrollbar = totalLog > logRows
  let thumbStart = 0
  let thumbEnd = 0
  if (showScrollbar) {
    thumbStart = Math.floor((start / totalLog) * logRows)
    thumbEnd = Math.min(logRows, thumbStart + Math.max(1, Math.round((logRows / totalLog) * logRows)))
  }

  const lines = []
  for (let i = 0; i < logRows; i++) {
    const content = wrappedLogs[i] || ""
    if (showScrollbar) {
      const bar = i >= thumbStart && i < thumbEnd
        ? paint("┃", theme.semantic.warn)
        : paint("│", theme.base.border, { dim: true })
      lines.push(clipAnsiLine(content, width - 2) + " " + bar)
    } else {
      lines.push(clipAnsiLine(content, width))
    }
  }

  return {
    lines,
    scrollHint,
    scrollMeta,
    scrollOffset: clampedOffset,
    wrappedLogs
  }
}
