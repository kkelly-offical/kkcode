import test from "node:test"
import assert from "node:assert/strict"
import { styleInputMarkers } from "../src/repl/input-marker-style.mjs"
import { setColorEnabled } from "../src/theme/color.mjs"

/**
 * 附件占位标记的强调色后处理（1.0.1）。
 * 硬约束：颜色零宽度 —— 上完色的行剥掉 ANSI 后必须与原行逐字相同，
 * 否则输入框的宽度与光标记账会漂。
 */

const ESC = String.fromCharCode(27)
const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "")

function withColor(fn) {
  setColorEnabled(true)
  try { fn() } finally { setColorEnabled(null) }
}

test("a marker in an input line gets the accent colour, width untouched", () => {
  withColor(() => {
    const line = "看下这段 [Pasted text #2 · 2.8k chars] 再改"
    const styled = styleInputMarkers(line, { color: "#7dd3fc" })
    assert.equal(strip(styled), line, "上色不得改变可见内容")
    assert.ok(styled.includes("38;2;125;211;252"), "标记应着 inputMarker 色")
    // 颜色恰好包住标记，不多不少
    const open = styled.indexOf("38;2;125;211;252")
    const close = styled.indexOf(`${ESC}[0m`, open)
    assert.ok(styled.slice(open, close).includes("[Pasted text #2 · 2.8k chars]"))
  })
})

test("lines without markers or colour support pass through untouched", () => {
  withColor(() => {
    const plain = "没有标记的一行"
    assert.equal(styleInputMarkers(plain, { color: "#7dd3fc" }), plain)
  })
  const line = "有个 [Image #1] 标记"
  assert.equal(styleInputMarkers(line, { color: null }), line, "没有颜色配置时原样返回")
})

test("existing self-contained SGR pairs survive marker painting", () => {
  withColor(() => {
    // 前缀提示符与 ghost 都是自封口的码对，标记上色不得把它们剥掉
    const line = `${ESC}[38;2;52;211;153m❯ ${ESC}[0m看 [Image #1 · 3 B] 这${ESC}[90mghost${ESC}[0m`
    const styled = styleInputMarkers(line, { color: "#7dd3fc" })
    assert.equal(strip(styled), strip(line))
    assert.ok(styled.includes("38;2;52;211;153"), "前缀色还在")
    assert.ok(styled.includes("\x1b[90m"), "ghost 色还在")
    assert.ok(styled.includes("38;2;125;211;252"), "标记色进去了")
  })
})

test("a marker spanning an existing escape sequence is left alone", () => {
  withColor(() => {
    // 标记里嵌着选区反色（极端但可达）：不上色，让位给选区
    const line = `[Image #1 ${ESC}[7m· 3${ESC}[27m B]`
    assert.equal(styleInputMarkers(line, { color: "#7dd3fc" }), line)
  })
})

test("several markers in one line each get painted", () => {
  withColor(() => {
    const line = "A[Image #1 · 3 B]B[Video #2 · 12 MB]C"
    const styled = styleInputMarkers(line, { color: "#7dd3fc" })
    assert.equal(strip(styled), line)
    assert.equal(styled.split("38;2;125;211;252").length - 1, 2, "两个标记各上一段色")
  })
})
