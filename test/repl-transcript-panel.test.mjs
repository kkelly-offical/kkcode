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
