import test from "node:test"
import assert from "node:assert/strict"
import {
  stripAnsi, displayWidth, clipPlainByWidth, padRight, clipAnsiLine,
  wrapPlainLine, wrapLogLines, frameRow, frameTop, pageSize, ageLabel
} from "../src/repl/frame-primitives.mjs"

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const sgr = (code, text) => `${ESC}[${code}m${text}${ESC}[0m`
const osc8 = (url, text) => `${ESC}]8;;${url}${BEL}${text}${ESC}]8;;${BEL}`

test("stripAnsi removes every escape family, not just SGR", () => {
  // 合并前 repl.mjs 与 repl-dashboard.mjs 用的是 /\x1B\[[0-9;]*m/g，只认 SGR。
  // 剩下的序列被当成可打印文本留在输出里 —— 绘制时终端会真的执行它们。
  assert.equal(stripAnsi(sgr(31, "red")), "red")
  assert.equal(stripAnsi(`a${ESC}[2Kb`), "ab", "CSI 擦除行必须被剥掉")
  assert.equal(stripAnsi(`${ESC}[10;20Hxy`), "xy", "CSI 光标定位必须被剥掉")
  assert.equal(stripAnsi(osc8("http://x", "link")), "link", "OSC 超链接必须被剥掉")
  // OSC 的 ST 结尾（ESC \）与 BEL 结尾都要认 —— activity-renderer 的副本只认 BEL
  assert.equal(stripAnsi(`${ESC}]0;title${ESC}\\body`), "body")
})

test("padRight never leaks escape bytes into a cell it calls plain", () => {
  // 这是合并前真实发生的问题：padRight 用只认 SGR 的正则剥一遍，
  // 再把结果当纯文本填进帧格，OSC/CSI 字节就跟着进了帧。
  const padded = padRight(osc8("http://x", "link"), 10)
  assert.equal(padded, "link      ")
  assert.doesNotMatch(padded, new RegExp(ESC), "补齐后的单元格里不能有转义字节")
  assert.equal(displayWidth(padded), 10)

  const withCursor = padRight(`a${ESC}[2Kb`, 6)
  assert.equal(withCursor, "ab    ")
  assert.doesNotMatch(withCursor, new RegExp(ESC))
})

test("padRight measures CJK by cell width, not by string length", () => {
  // repl-help.mjs 的副本用的是 value.length：一行中文会宽出 4 格。
  // 它今天没发作只因为帮助表第一列恰好全是 ASCII 命令 —— 那是运气，不是设计。
  assert.equal(displayWidth(padRight("切换模式", 20)), 20)
  assert.equal(displayWidth(padRight("/help 显示帮助", 20)), 20)
  assert.equal(displayWidth(padRight(sgr(31, "/help"), 20)), 20)
  // 超宽时裁剪而不是溢出
  assert.equal(displayWidth(padRight("切换模式切换模式切换模式", 10)), 10)
})

test("padRight does not split a wide character in half", () => {
  // 目标宽度为奇数时，裁到中文字符中间会让终端显示半个字并错位后续所有列
  const out = padRight("中文中文", 5)
  assert.equal(displayWidth(out), 5)
  assert.equal(out, "中文 ", "应保留两个整字后补一个空格，而不是切开第三个字")
})

test("clipAnsiLine keeps colour but marks truncation", () => {
  const short = clipAnsiLine(sgr(31, "red"), 8)
  assert.match(short, new RegExp(`${ESC.replace("[", "\\[")}\\[31m`), "未超宽时颜色码要保留")
  assert.equal(displayWidth(short), 8)

  const long = clipAnsiLine("abcdefghij", 5)
  assert.equal(long, "abcd~", "超宽时末位换成 ~ 以示截断")
  assert.equal(displayWidth(long), 5)

  assert.equal(displayWidth(clipAnsiLine("中文中文中文", 7)), 7, "宽字符截断后宽度仍要准")
})

test("clipPlainByWidth stops on grapheme boundaries", () => {
  assert.equal(clipPlainByWidth("中文abc", 4), "中文")
  assert.equal(clipPlainByWidth("中文abc", 5), "中文a")
  assert.equal(clipPlainByWidth("abc", 0), "")
  assert.equal(clipPlainByWidth("", 5), "")
})

test("wrapPlainLine hard-wraps without dropping content", () => {
  const parts = wrapPlainLine("abcdefghij", 4)
  assert.deepEqual(parts, ["abcd", "efgh", "ij"])
  assert.equal(parts.join(""), "abcdefghij", "折行不能丢字符")
  assert.deepEqual(wrapPlainLine("", 10), [""])
  assert.deepEqual(wrapPlainLine("abc", 0), [""])
})

test("wrapLogLines keeps the tail when capped", () => {
  // 日志的关键信息在最后 —— 截头比截尾有用
  const lines = ["1", "2", "3", "4", "5"]
  assert.deepEqual(wrapLogLines(lines, 10, 2), ["4", "5"])
  assert.deepEqual(wrapLogLines(lines, 10), lines)
  assert.deepEqual(wrapLogLines(lines, 10, null), lines)
})

test("frame rows are exactly the requested width", () => {
  // 0.6.1 的状态栏事故就是宽度分档从未被测过 —— 那时宽度来自
  // process.stdout.columns，测试进程里恒为 undefined。这里宽度是参数。
  for (const width of [20, 40, 80, 86, 120]) {
    assert.equal(displayWidth(stripAnsi(frameTop(width, null))), width, `frameTop @ ${width}`)
    assert.equal(displayWidth(stripAnsi(frameRow("x", width, null))), width, `frameRow @ ${width}`)
    assert.equal(
      displayWidth(stripAnsi(frameRow("中文内容很长很长很长很长很长很长", width, null))),
      width,
      `frameRow 宽字符溢出 @ ${width}`
    )
  }
})

test("pageSize leaves overlap so context survives a page turn", () => {
  assert.equal(pageSize(40), 30)
  assert.equal(pageSize(1), 1, "极小终端也要能翻至少一行")
  assert.equal(pageSize(0), 1)
})

test("ageLabel degrades by unit", () => {
  assert.equal(ageLabel(0), "just now")
  assert.equal(ageLabel(5 * 60000), "5m ago")
  assert.equal(ageLabel(3 * 3600000), "3h ago")
  assert.equal(ageLabel(2 * 86400000), "2d ago")
})
