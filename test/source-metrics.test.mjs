import test from "node:test"
import assert from "node:assert/strict"
import { measureFunctions, countLines, stripCommentsAndStrings, toLines } from "../src/util/source-metrics.mjs"

/**
 * 行尾是这个项目栽过四次的那类 Windows 分歧里的第四次。
 *
 * 仓库没有 .gitattributes，Windows 上 git 可能按 CRLF 签出。按 `\n` 切行之后每行
 * 尾部带着 `\r`，于是「这一行是不是恰好等于缩进 + `}`」永远为假，函数边界一个都
 * 找不到、每个函数都被算到文件末尾。0.6.27 的结构守卫就是这么在 Windows 上红的，
 * 而 Linux 全绿。
 *
 * 所以这些断言写在这里 —— 它们在 Linux 上也会红。
 */

const SAMPLE = [
  "function small(a) {",
  "  if (a) return 1",
  "  return 0",
  "}",
  "",
  "export async function bigger(list) {",
  "  for (const x of list) {",
  "    if (x && x.ok) continue",
  "  }",
  "  return list.length || 0",
  "}"
].join("\n")

const withCRLF = (text) => text.replace(/\n/g, "\r\n")
const withCR = (text) => text.replace(/\n/g, "\r")

test("function boundaries are found regardless of line endings", () => {
  const lf = measureFunctions(SAMPLE)
  assert.deepEqual(lf.map((f) => f.name), ["small", "bigger"])
  assert.equal(lf[0].lines, 4, "small 是 4 行")
  assert.equal(lf[1].lines, 6, "bigger 是 6 行")

  for (const [label, convert] of [["CRLF", withCRLF], ["CR", withCR]]) {
    const measured = measureFunctions(convert(SAMPLE))
    assert.deepEqual(measured, lf, `${label} 行尾下的度量必须与 LF 完全一致`)
  }
})

test("a function that runs to end-of-file is the symptom of a broken boundary", () => {
  // 这条把失败模式本身钉下来：边界找不到时，函数会被算到文件末尾，
  // 行数与判定点一起爆表 —— 正是 Windows 上看到的现象。
  const measured = measureFunctions(withCRLF(SAMPLE))
  const total = countLines(SAMPLE)
  for (const fn of measured) {
    assert.ok(fn.lines < total, `${fn.name} 占了 ${fn.lines} 行、几乎等于整个文件 —— 边界没找到`)
  }
})

test("decision points count branches and short-circuits, not lines", () => {
  const [small, bigger] = measureFunctions(SAMPLE)
  assert.equal(small.decisions, 1, "一个 if")
  assert.equal(bigger.decisions, 4, "for + if + && + ||")
})

test("comments and strings do not contribute decision points", () => {
  const noisy = [
    "function f() {",
    "  // if this && that || other",
    '  const a = "if (x && y) return"',
    "  const b = `for (const z of w) {}`",
    "  /* while (true) { case 1: } */",
    "  return a || b",
    "}"
  ].join("\n")
  const [fn] = measureFunctions(noisy)
  assert.equal(fn.decisions, 1, `只有真实的 || 算一个判定点，实际数出 ${fn.decisions}`)
})

test("stripping leaves the code structure intact", () => {
  const stripped = stripCommentsAndStrings('const x = "a || b" // if\nif (x) return')
  assert.match(stripped, /if \(x\) return/, "真实的分支要留下")
  assert.doesNotMatch(stripped, /a \|\| b/, "字符串里的内容要拆掉")
})

test("line counting agrees with the function measurement", () => {
  // 两处用不同的切行方式的话，同一个文件会数出不同的行数
  for (const convert of [(t) => t, withCRLF, withCR]) {
    assert.equal(countLines(convert(SAMPLE)), 11, "行数不该随行尾变化")
  }
})

test("toLines normalizes without swallowing blank lines", () => {
  assert.deepEqual(toLines("a\r\n\r\nb"), ["a", "", "b"], "空行要保留 —— 否则行号会错位")
})

test("an unterminated function does not hang or throw", () => {
  // 截断的文件（编辑到一半、生成中）不该让度量工具崩掉
  const truncated = "function oops() {\n  if (a) {\n"
  assert.doesNotThrow(() => measureFunctions(truncated))
  const [fn] = measureFunctions(truncated)
  assert.equal(fn.name, "oops")
})

test("nested functions are measured independently of their parent", () => {
  const nested = [
    "function outer() {",
    "  function inner(a) {",
    "    if (a) return 1",
    "  }",
    "  return inner",
    "}"
  ].join("\n")
  const measured = measureFunctions(nested)
  assert.deepEqual(measured.map((f) => f.name), ["outer", "inner"])
  assert.equal(measured[0].lines, 6)
  assert.equal(measured[1].lines, 3, "内层函数按自己的缩进收尾")
})
