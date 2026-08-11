import test from "node:test"
import assert from "node:assert/strict"
import { buildTranscriptViewport } from "../src/ui/repl-transcript-panel.mjs"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"

test("buildTranscriptViewport clamps offset and returns visible lines", () => {
  const viewport = buildTranscriptViewport({
    logs: ["one", "two", "three", "four"],
    width: 20,
    logRows: 2,
    scrollOffset: 99,
    wrapLogLines(lines) {
      return lines
    },
    clipAnsiLine(text) {
      return text
    },
    paint(text) {
      return text
    },
    theme: DEFAULT_THEME
  })
  assert.equal(viewport.scrollOffset, 2)
  assert.deepEqual(viewport.lines, ["one ┃", "two │"])
})

test("buildTranscriptViewport omits scrollbar when all logs fit", () => {
  const viewport = buildTranscriptViewport({
    logs: ["one"],
    width: 20,
    logRows: 3,
    scrollOffset: 0,
    wrapLogLines(lines) {
      return lines
    },
    clipAnsiLine(text) {
      return text
    },
    paint(text) {
      return text
    },
    theme: DEFAULT_THEME
  })
  assert.equal(viewport.lines[0], "one")
  assert.match(viewport.scrollHint, /Ctrl\+Up\/Down scroll/)
})

test("buildTranscriptViewport preserves structured item hit regions", () => {
  const viewport = buildTranscriptViewport({
    logs: [{
      id: "tool-1",
      kind: "tool",
      summary: "Edit src/app.mjs",
      details: ["    - old", "    + new"],
      expanded: true
    }],
    width: 30,
    logRows: 3,
    scrollOffset: 0,
    wrapLogLines(lines) {
      return lines
    },
    clipAnsiLine(text) {
      return text
    },
    paint(text) {
      return text
    },
    theme: DEFAULT_THEME
  })

  assert.deepEqual(
    viewport.wrappedLogs,
    ["▾ Edit src/app.mjs", "    - old", "    + new"]
  )
  assert.equal(viewport.hitRegions.length, 3)
  assert.deepEqual(
    viewport.hitRegions.map((region) => region.itemId),
    ["tool-1", "tool-1", "tool-1"]
  )
  assert.deepEqual(
    viewport.hitRegions.map((region) => region.row),
    [1, 2, 3]
  )
})

function viewportOf(logs, { logRows = 2, scrollOffset = 0 } = {}) {
  return buildTranscriptViewport({
    logs,
    width: 20,
    logRows,
    scrollOffset,
    wrapLogLines(lines) { return lines },
    clipAnsiLine(text) { return text },
    paint(text) { return text },
    theme: DEFAULT_THEME
  })
}

test("buildTranscriptViewport reports where the viewport starts in the full transcript", () => {
  // drag-selection stores absolute transcript rows, so it needs this offset to
  // convert screen rows and survive scrolling mid-drag
  const bottom = viewportOf(["one", "two", "three", "four"])
  assert.equal(bottom.visibleStartIndex, 2)
  assert.deepEqual(bottom.wrappedLogs, ["three", "four"])

  const scrolledUp = viewportOf(["one", "two", "three", "four"], { scrollOffset: 2 })
  assert.equal(scrolledUp.visibleStartIndex, 0)
  assert.deepEqual(scrolledUp.wrappedLogs, ["one", "two"])
})

test("buildTranscriptViewport exposes every wrapped line for off-screen selection", () => {
  const viewport = viewportOf(["one", "two", "three", "four"])
  // selection can extend past the viewport, so the copy path reads from here
  // rather than from the last painted frame
  assert.deepEqual(viewport.allLines, ["one", "two", "three", "four"])
})

test("visibleStartIndex stays zero when everything fits on screen", () => {
  const viewport = viewportOf(["one", "two"], { logRows: 5 })
  assert.equal(viewport.visibleStartIndex, 0)
})

// ---------------------------------------------------------------------------
// 滚动锚定。scrollOffset 是「到底部的距离」：用户已向上滚（offset > 0）时来了
// 新内容，偏移量不动就意味着视图跟着内容往下漂。只看 totalRows 也不够：
// 展开/折叠、streaming 重排和 resize 都会改行数。scrollMeta 因此保存可见行身份。
// ---------------------------------------------------------------------------
const passthrough = {
  wrapLogLines(lines) { return lines },
  clipAnsiLine(text) { return text },
  paint(text) { return text }
}

test("scrolled-up view stays anchored when new lines arrive", () => {
  const logs = Array.from({ length: 10 }, (_, i) => `line-${i}`)
  const before = buildTranscriptViewport({
    logs, width: 20, logRows: 2, scrollOffset: 3,
    ...passthrough, theme: DEFAULT_THEME
  })
  assert.equal(before.scrollOffset, 3)
  const topLineBefore = before.wrappedLogs[0]

  const after = buildTranscriptViewport({
    logs: [...logs, "new-a", "new-b", "new-c"],
    width: 20, logRows: 2, scrollOffset: before.scrollOffset,
    previousScrollMeta: before.scrollMeta,
    ...passthrough, theme: DEFAULT_THEME
  })
  assert.equal(after.scrollOffset, 6, "偏移量应加上新增行数，视图锚在原地")
  assert.equal(after.wrappedLogs[0], topLineBefore, "视口首行内容不应漂移")
})

test("bottom-follow behavior is untouched: offset 0 stays 0 as lines arrive", () => {
  const logs = Array.from({ length: 10 }, (_, i) => `line-${i}`)
  const before = buildTranscriptViewport({
    logs, width: 20, logRows: 2, scrollOffset: 0,
    ...passthrough, theme: DEFAULT_THEME
  })
  const after = buildTranscriptViewport({
    logs: [...logs, "new-a"],
    width: 20, logRows: 2, scrollOffset: 0,
    previousScrollMeta: before.scrollMeta,
    ...passthrough, theme: DEFAULT_THEME
  })
  assert.equal(after.scrollOffset, 0)
  assert.equal(after.wrappedLogs.at(-1), "new-a", "底部跟随必须继续显示最新行")
})

test("a width change keeps the same logical line anchored instead of trusting row deltas", () => {
  const logs = Array.from({ length: 10 }, (_, i) => `line-${i}`)
  const before = buildTranscriptViewport({
    logs, width: 40, logRows: 2, scrollOffset: 3,
    ...passthrough, theme: DEFAULT_THEME
  })
  const after = buildTranscriptViewport({
    logs: [...logs, "new-a"],
    width: 20, logRows: 2, scrollOffset: 3,
    previousScrollMeta: before.scrollMeta,
    ...passthrough, theme: DEFAULT_THEME
  })
  assert.equal(after.wrappedLogs[0], before.wrappedLogs[0])
  assert.equal(after.scrollOffset, 4, "宽度变化时应按稳定行身份重算 offset")
})

test("expanding an item above the viewport does not move the visible item", () => {
  const logs = Array.from({ length: 10 }, (_, index) => ({
    id: `item-${index}`,
    summary: `line-${index}`,
    details: index === 0 ? ["detail-a", "detail-b", "detail-c"] : [],
    expanded: false
  }))
  const before = buildTranscriptViewport({
    logs, width: 20, logRows: 2, scrollOffset: 3,
    ...passthrough, theme: DEFAULT_THEME
  })
  const anchoredId = before.visibleLineMeta[0].itemId

  const after = buildTranscriptViewport({
    logs: logs.map((item, index) => index === 0 ? { ...item, expanded: true } : item),
    width: 20, logRows: 2, scrollOffset: before.scrollOffset,
    previousScrollMeta: before.scrollMeta,
    ...passthrough, theme: DEFAULT_THEME
  })
  assert.equal(after.visibleLineMeta[0].itemId, anchoredId)
})

test("collapsing expanded content below the viewport keeps the visible item", () => {
  const logs = Array.from({ length: 10 }, (_, index) => ({
    id: `item-${index}`,
    summary: `line-${index}`,
    details: index === 9 ? ["tail-a", "tail-b", "tail-c"] : [],
    expanded: index === 9
  }))
  const before = buildTranscriptViewport({
    logs, width: 20, logRows: 2, scrollOffset: 3,
    ...passthrough, theme: DEFAULT_THEME
  })
  const anchoredId = before.visibleLineMeta[0].itemId

  const after = buildTranscriptViewport({
    logs: logs.map((item, index) => index === 9 ? { ...item, expanded: false } : item),
    width: 20, logRows: 2, scrollOffset: before.scrollOffset,
    previousScrollMeta: before.scrollMeta,
    ...passthrough, theme: DEFAULT_THEME
  })
  assert.equal(after.visibleLineMeta[0].itemId, anchoredId)
})

test("real rewrapping on resize preserves the logical transcript item", () => {
  const logs = Array.from({ length: 9 }, (_, index) => ({
    id: `long-${index}`,
    summary: `${index}:` + "x".repeat(28)
  }))
  const wrap = {
    wrapLogLines(lines, width) {
      return lines.flatMap((line) => {
        const chunks = []
        for (let index = 0; index < line.length; index += width) chunks.push(line.slice(index, index + width))
        return chunks.length ? chunks : [""]
      })
    },
    clipAnsiLine(text) { return text },
    paint(text) { return text }
  }
  const before = buildTranscriptViewport({
    logs, width: 20, logRows: 3, scrollOffset: 4,
    ...wrap, theme: DEFAULT_THEME
  })
  const anchoredId = before.visibleLineMeta[0].itemId
  const after = buildTranscriptViewport({
    logs, width: 10, logRows: 3, scrollOffset: before.scrollOffset,
    previousScrollMeta: before.scrollMeta,
    ...wrap, theme: DEFAULT_THEME
  })
  assert.equal(after.visibleLineMeta[0].itemId, anchoredId)
})

test("a user scroll between frames wins over automatic anchoring", () => {
  const logs = Array.from({ length: 12 }, (_, index) => ({ id: `item-${index}`, summary: `line-${index}` }))
  const before = buildTranscriptViewport({
    logs, width: 20, logRows: 2, scrollOffset: 3,
    ...passthrough, theme: DEFAULT_THEME
  })
  // 请求移动 2 行，而尾部只新增 1 行；这两个数刻意不同，
  // 否则即使删掉「用户手动滚动优先」分支，自动锚定也会算出同一结果。
  const requestedOffset = before.scrollOffset + 2
  const after = buildTranscriptViewport({
    logs: [...logs, { id: "new", summary: "new" }],
    width: 20, logRows: 2, scrollOffset: requestedOffset,
    previousScrollMeta: before.scrollMeta,
    ...passthrough, theme: DEFAULT_THEME
  })
  assert.equal(after.scrollOffset, requestedOffset)
})

test("when the first visible anchor is deleted, the next candidate preserves its viewport row", () => {
  const logs = Array.from({ length: 12 }, (_, index) => ({ id: `item-${index}`, summary: `line-${index}` }))
  const before = buildTranscriptViewport({
    logs, width: 20, logRows: 3, scrollOffset: 4,
    ...passthrough, theme: DEFAULT_THEME
  })
  const deletedId = before.visibleLineMeta[0].itemId
  const fallbackId = before.visibleLineMeta[1].itemId

  const after = buildTranscriptViewport({
    logs: logs.filter((item) => item.id !== deletedId),
    width: 20, logRows: 3, scrollOffset: before.scrollOffset,
    previousScrollMeta: before.scrollMeta,
    ...passthrough, theme: DEFAULT_THEME
  })
  assert.equal(after.visibleLineMeta[1].itemId, fallbackId,
    "首个候选消失时应继续用第二个，且保持它原来的屏幕行")
})

test("when widening removes an old wrapped index, the nearest surviving row is used", () => {
  const logs = [
    { id: "head", summary: "head" },
    { id: "target", summary: "x".repeat(32) },
    { id: "tail-a", summary: "tail-a" },
    { id: "tail-b", summary: "tail-b" },
    { id: "tail-c", summary: "tail-c" }
  ]
  const wrap = {
    wrapLogLines(lines, width) {
      return lines.flatMap((line) => {
        const parts = []
        for (let index = 0; index < line.length; index += width) parts.push(line.slice(index, index + width))
        return parts.length ? parts : [""]
      })
    },
    clipAnsiLine(text) { return text },
    paint(text) { return text }
  }
  const before = buildTranscriptViewport({
    logs, width: 6, logRows: 2, scrollOffset: 3,
    ...wrap, theme: DEFAULT_THEME
  })
  const targetAnchor = before.scrollMeta.anchorCandidates.find((anchor) => anchor.itemId === "target")
  assert.ok(targetAnchor && targetAnchor.wrappedIndex > 0, "前置条件：锚点位于目标的后续换行")

  const after = buildTranscriptViewport({
    logs, width: 24, logRows: 2, scrollOffset: before.scrollOffset,
    previousScrollMeta: before.scrollMeta,
    ...wrap, theme: DEFAULT_THEME
  })
  assert.ok(after.visibleLineMeta.some((line) => line.itemId === "target"),
    "原 wrappedIndex 消失时不应放弃整个逻辑行锚点")
})

test("changing logRows keeps the same transcript line anchored", () => {
  const logs = Array.from({ length: 16 }, (_, index) => ({ id: `item-${index}`, summary: `line-${index}` }))
  const before = buildTranscriptViewport({
    logs, width: 20, logRows: 5, scrollOffset: 4,
    ...passthrough, theme: DEFAULT_THEME
  })
  const topId = before.visibleLineMeta[0].itemId
  const after = buildTranscriptViewport({
    logs, width: 20, logRows: 2, scrollOffset: before.scrollOffset,
    previousScrollMeta: before.scrollMeta,
    ...passthrough, theme: DEFAULT_THEME
  })
  assert.equal(after.visibleLineMeta[0].itemId, topId,
    "浮层占用更多屏幕行时，对话区缩短不应让内容跳动")
})
