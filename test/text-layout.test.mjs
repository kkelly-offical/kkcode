import test from "node:test"
import assert from "node:assert/strict"
import {
  inputIndexAtPosition,
  layoutInputText,
  moveGraphemeCursor,
  splitTextByCellRange,
  stripTerminalAnsi,
  terminalCellWidth,
  wrapAnsiLine
} from "../src/repl/text-layout.mjs"

test("ANSI wrapping preserves styles on every physical row", () => {
  const source = "\x1b[2mabcdef\x1b[0m"
  const rows = wrapAnsiLine(source, 3)
  assert.equal(rows.length, 2)
  assert.equal(stripTerminalAnsi(rows[0]), "abc")
  assert.equal(stripTerminalAnsi(rows[1]), "def")
  assert.match(rows[0], /\x1b\[2m/)
  assert.match(rows[1], /\x1b\[2m/)
})

test("terminal cell width handles CJK, emoji, and combining graphemes", () => {
  assert.equal(terminalCellWidth("A中🙂"), 5)
  assert.equal(terminalCellWidth("e\u0301"), 1)
  assert.equal(moveGraphemeCursor("a🙂b", 3, -1), 1)
  assert.equal(moveGraphemeCursor("a🙂b", 1, 1), 3)
})

test("emoji presentation sequences use two cells", () => {
  assert.equal(terminalCellWidth("©️"), 2)
  assert.equal(terminalCellWidth("1️⃣"), 2)
})

test("input layout keeps the hardware cursor visible across wrapped rows", () => {
  const layout = layoutInputText({
    value: "abcd中文efgh",
    cursor: "abcd中文efgh".length,
    width: 6,
    maxRows: 2,
    prefix: "❯ "
  })
  assert.ok(layout.lines.length <= 2)
  assert.ok(layout.cursor.row >= 0 && layout.cursor.row < layout.lines.length)
  assert.equal(inputIndexAtPosition(layout, layout.cursor.row, layout.cursor.col), "abcd中文efgh".length)
})

test("full input rows wrap the hardware cursor before the composer border", () => {
  const layout = layoutInputText({
    value: "123456",
    cursor: 6,
    width: 6,
    maxRows: 5,
    prefix: ""
  })
  assert.deepEqual(layout.lines, ["123456", ""])
  assert.deepEqual(layout.cursor, { row: 1, col: 0 })
  assert.equal(inputIndexAtPosition(layout, 1, 0), 6)
})

test("input layout expands tabs and renders controls without terminal escapes", () => {
  const layout = layoutInputText({
    value: "a\tb\x1bc",
    cursor: 5,
    width: 20,
    prefix: ""
  })
  assert.equal(layout.lines.join(""), "a   b␛c")
  assert.equal(layout.cursor.col, 7)
  assert.equal(layout.lines.join("").includes("\x1b"), false)
})

test("input screen mapping accounts for explicit newlines", () => {
  const layout = layoutInputText({
    value: "first\nsecond",
    cursor: 8,
    width: 20,
    maxRows: 5,
    prefix: "❯ "
  })
  assert.equal(layout.cursor.row, 1)
  assert.equal(inputIndexAtPosition(layout, 1, 2), 8)
})

test("cell-range selection does not split CJK or emoji graphemes", () => {
  const selected = splitTextByCellRange("A中🙂B", 1, 5)
  assert.deepEqual(selected, { before: "A", selected: "中🙂", after: "B" })
})
