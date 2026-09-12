import test from "node:test"
import assert from "node:assert/strict"
import {
  stripAnsi, displayWidth, clipPlainByWidth, padRight, clipAnsiLine,
  wrapPlainLine, wrapLogLines, frameTop, frameRow, pageSize, ageLabel
} from "../src/util/frame-primitives.mjs"
import {
  stripTerminalAnsi, splitGraphemes, terminalCellWidth, wrapAnsiLine,
  clipAnsiByWidth, moveGraphemeCursor, maskSecretText, layoutInputText,
  inputIndexAtPosition, splitTextByCellRange
} from "../src/util/text-layout.mjs"
import { QUESTION_SKIPPED } from "../src/core/constants.mjs"
import { QUESTION_SKIPPED as ROUTER_QUESTION_SKIPPED } from "../src/repl/dialog-router.mjs"

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const sgr = (code, text) => `${ESC}[${code}m${text}${ESC}[0m`
const osc8 = (url, text) => `${ESC}]8;;${url}${BEL}${text}${ESC}]8;;${BEL}`

// 1.0.0 阶段 1c：这些纯函数从 src/repl/ 逐字搬到 src/util/；阶段 2c 退役了
// repl/ 下的兼容转出口，全部调用方直指 src/util/。本文件钉住两件事：新家路径
// 下的行为与旧契约一致；dialog-router 的再导出与新路径是**同一份实现**
// （引用相等），不存在第二份副本。

test("dialog-router re-exports the very same constant", () => {
  assert.equal(ROUTER_QUESTION_SKIPPED, QUESTION_SKIPPED)
  assert.equal(QUESTION_SKIPPED, "(skipped)")
})

test("stripAnsi removes every escape family, not just SGR", () => {
  assert.equal(stripAnsi(sgr(31, "red")), "red")
  assert.equal(stripAnsi(`a${ESC}[2Kb`), "ab", "CSI 擦除行必须被剥掉")
  assert.equal(stripAnsi(osc8("http://x", "link")), "link", "OSC 超链接必须被剥掉")
  assert.equal(stripAnsi(`${ESC}]0;title${ESC}\\body`), "body", "OSC 的 ST 结尾也要认")
  assert.equal(stripTerminalAnsi(sgr(2, "dim")), "dim")
})

test("displayWidth measures cells: CJK and emoji count 2, combining count 0", () => {
  assert.equal(displayWidth("abc"), 3)
  assert.equal(displayWidth("中文"), 4)
  assert.equal(terminalCellWidth("A中🙂"), 5)
  assert.equal(terminalCellWidth("é"), 1)
  assert.equal(displayWidth(sgr(31, "red")), 3, "颜色码不占宽度")
})

test("padRight returns plain padded text at exact cell width", () => {
  assert.equal(padRight(osc8("http://x", "link"), 10), "link      ")
  assert.equal(padRight("中文中文", 5), "中文 ", "不切开宽字符，缺的一格补空格")
  assert.equal(displayWidth(padRight("切换模式切换模式切换模式", 10)), 10, "超宽要裁")
})

test("clipPlainByWidth stops on grapheme boundaries", () => {
  assert.equal(clipPlainByWidth("中文abc", 4), "中文")
  assert.equal(clipPlainByWidth("中文abc", 5), "中文a")
  assert.equal(clipPlainByWidth("abc", 0), "")
})

test("clipAnsiLine keeps colour but marks truncation with ~", () => {
  const short = clipAnsiLine(sgr(31, "red"), 8)
  assert.match(short, /\x1b\[31m/, "未超宽时颜色码要保留")
  assert.equal(displayWidth(short), 8)
  assert.equal(clipAnsiLine("abcdefghij", 5), "abcd~")
  assert.equal(displayWidth(clipAnsiLine("中文中文中文", 7)), 7)
  assert.equal(clipAnsiByWidth("abcdef", 3), "abc")
})

test("wrapPlainLine hard-wraps without dropping content", () => {
  assert.deepEqual(wrapPlainLine("abcdefghij", 4), ["abcd", "efgh", "ij"])
  assert.deepEqual(wrapPlainLine("", 10), [""])
})

test("wrapLogLines keeps the tail when capped", () => {
  const lines = ["1", "2", "3", "4", "5"]
  assert.deepEqual(wrapLogLines(lines, 10, 2), ["4", "5"])
  assert.deepEqual(wrapLogLines(lines, 10, null), lines)
})

test("frame rows are exactly the requested width", () => {
  for (const width of [20, 80, 120]) {
    assert.equal(displayWidth(stripAnsi(frameTop(width, null))), width)
    assert.equal(displayWidth(stripAnsi(frameRow("x", width, null))), width)
    assert.equal(displayWidth(stripAnsi(frameRow("中文内容很长很长很长很长", width, null))), width)
  }
})

test("pageSize leaves overlap so context survives a page turn", () => {
  assert.equal(pageSize(40), 30)
  assert.equal(pageSize(0), 1)
})

test("ageLabel degrades by unit", () => {
  assert.equal(ageLabel(0), "just now")
  assert.equal(ageLabel(5 * 60000), "5m ago")
  assert.equal(ageLabel(3 * 3600000), "3h ago")
  assert.equal(ageLabel(2 * 86400000), "2d ago")
})

test("splitGraphemes keeps emoji ZWJ sequences as one cluster", () => {
  const clusters = splitGraphemes("a👨‍👩‍👧‍👦b")
  assert.deepEqual(clusters.map((part) => part.text), ["a", "👨‍👩‍👧‍👦", "b"])
  assert.deepEqual(splitGraphemes(""), [])
})

test("wrapAnsiLine preserves styles on every physical row", () => {
  const rows = wrapAnsiLine("\x1b[2mabcdef\x1b[0m", 3)
  assert.equal(rows.length, 2)
  assert.equal(stripTerminalAnsi(rows[0]), "abc")
  assert.equal(stripTerminalAnsi(rows[1]), "def")
  assert.match(rows[0], /\x1b\[2m/)
  assert.match(rows[1], /\x1b\[2m/)
})

test("moveGraphemeCursor never lands inside a grapheme", () => {
  assert.equal(moveGraphemeCursor("a🙂b", 3, -1), 1)
  assert.equal(moveGraphemeCursor("a🙂b", 1, 1), 3)
})

test("maskSecretText masks per grapheme and maps the cursor into mask coordinates", () => {
  const masked = maskSecretText("a🙂b", 3)
  assert.equal(masked.value, "•••")
  assert.equal(masked.cursor, 2, "光标在 🙂（1 簇）之后 → 遮蔽串下标 2")
  assert.equal(masked.normalizedCursor, 3)
  assert.deepEqual(maskSecretText("", 0), { value: "", cursor: 0, normalizedCursor: 0 })
})

test("layoutInputText wraps by cell width and reports cursor row/col", () => {
  const layout = layoutInputText({ value: "abcde", cursor: 5, width: 3, maxRows: 5 })
  assert.deepEqual(layout.lines, ["abc", "de"])
  assert.deepEqual(layout.cursor, { row: 1, col: 2 })
  assert.equal(layout.normalizedCursor, 5)
})

test("inputIndexAtPosition maps a clicked cell back to a string index", () => {
  const layout = layoutInputText({ value: "abcd", cursor: 0, width: 80 })
  assert.equal(inputIndexAtPosition(layout, 0, 0), 0)
  assert.equal(inputIndexAtPosition(layout, 0, 2), 2)
  assert.equal(inputIndexAtPosition(layout, 0, 99), 4)
})

test("splitTextByCellRange splits before/selected/after by cells", () => {
  const parts = splitTextByCellRange("中abcd", 2, 4)
  assert.deepEqual(parts, { before: "中", selected: "ab", after: "cd" })
})
