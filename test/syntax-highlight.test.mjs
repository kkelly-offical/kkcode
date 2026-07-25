import test, { describe, it, afterEach } from "node:test"
import assert from "node:assert/strict"
import { highlightLine, normalizeLanguage, isHighlightable } from "../src/theme/syntax-highlight.mjs"
import { renderMarkdown, createStreamRenderer, setMarkdownColors } from "../src/theme/markdown.mjs"
import { setColorEnabled } from "../src/theme/color.mjs"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"

/**
 * 0.6.0：代码块语法高亮。
 *
 * 核心不变式是「只加颜色、不改字符」—— 高亮器绝不能动代码本身，
 * 否则用户复制屏幕上的代码会拿到坏内容。
 */

const ESC = String.fromCharCode(27)
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g")
const PRIVATE_USE = new RegExp(`[${String.fromCharCode(0xE000)}-${String.fromCharCode(0xF8FF)}]`)
const colors = DEFAULT_THEME.markdown

afterEach(() => {
  setColorEnabled(null)
  setMarkdownColors(null)
})

function stripSgr(text) {
  return text.replace(SGR, "")
}

describe("只加颜色，不改字符", () => {
  const samples = [
    ["const x = foo(42) // note", "js"],
    ["def run(a): return a + 1", "python"],
    ["SELECT * FROM t WHERE id = 3", "sql"],
    ['const s = "a // b" // real', "js"],
    ["echo $HOME # comment", "bash"],
    ["fn main() { let x = 5; }", "rust"],
    ["key: value  # yaml comment", "yaml"]
  ]

  for (const [line, lang] of samples) {
    it(`${lang}: 去掉 SGR 后与原文逐字相同`, () => {
      setColorEnabled(true)
      const out = highlightLine(line, lang, colors)
      assert.equal(stripSgr(out), line)
      assert.notEqual(out, line, "应该确实上了色")
      assert.doesNotMatch(out, PRIVATE_USE, "占位符必须全部还原")
    })
  }
})

describe("边界与降级", () => {
  it("未知语言原样返回", () => {
    setColorEnabled(true)
    assert.equal(highlightLine("whatever ~~ ??", "brainfuck", colors), "whatever ~~ ??")
  })

  it("无色终端下原样返回", () => {
    setColorEnabled(false)
    assert.equal(highlightLine("const x = 1", "js", colors), "const x = 1")
  })

  it("超长行直接放行，不让正则在病理输入上退化", () => {
    setColorEnabled(true)
    const long = "x".repeat(3000)
    assert.equal(highlightLine(long, "js", colors), long)
  })

  it("空行与非字符串输入安全", () => {
    setColorEnabled(true)
    assert.equal(highlightLine("", "js", colors), "")
    assert.equal(highlightLine(null, "js", colors), "")
  })

  it("语言别名归一", () => {
    assert.equal(normalizeLanguage("TypeScript"), "ts")
    assert.equal(normalizeLanguage("yml"), "yaml")
    assert.equal(normalizeLanguage("Bash"), "bash")
    assert.equal(normalizeLanguage("nope"), null)
    assert.equal(isHighlightable("python3"), true)
    assert.equal(isHighlightable(""), false)
  })

  it("diff 的增删行分色", () => {
    setColorEnabled(true)
    const added = highlightLine("+new line", "diff", colors)
    const removed = highlightLine("-old line", "diff", colors)
    assert.notEqual(added, removed)
    assert.equal(stripSgr(added), "+new line")
    assert.equal(stripSgr(removed), "-old line")
  })
})

describe("接进 markdown 渲染", () => {
  it("围栏代码块被高亮，且内容可完整还原", () => {
    setColorEnabled(true)
    const md = "```js\nconst answer = 42\n```"
    const rendered = renderMarkdown(md)
    assert.match(rendered, /const/)
    assert.ok(stripSgr(rendered).includes("const answer = 42"))
    assert.doesNotMatch(rendered, PRIVATE_USE)
  })

  it("流式渲染的输出与分片边界无关（高亮逐行独立的理由）", () => {
    setColorEnabled(true)
    const source = "```js\nconst a = 1\nlet b = 2 // x\n```\n\n# 标题\n\n普通段落\n"
    const whole = createStreamRenderer()
    const wholeOut = whole.push(source) + whole.flush()

    for (const size of [1, 3, 7, 17]) {
      const chunked = createStreamRenderer()
      let out = ""
      for (let i = 0; i < source.length; i += size) out += chunked.push(source.slice(i, i + size))
      out += chunked.flush()
      assert.equal(out, wholeOut, `分片大小 ${size} 的输出与整块不一致`)
    }
  })

  it("标题按层级分色", () => {
    setColorEnabled(true)
    const h1 = renderMarkdown("# one")
    const h3 = renderMarkdown("### three")
    assert.notEqual(stripSgr(h1), h1)
    assert.notEqual(h1.replace(/one/, ""), h3.replace(/three/, ""), "h1 与 h3 应当用不同颜色")
  })

  it("水平线被识别（此前原样输出）", () => {
    setColorEnabled(true)
    const rendered = renderMarkdown("---")
    assert.match(stripSgr(rendered), /─+/)
  })

  it("setMarkdownColors 覆盖后配色随主题变化", () => {
    setColorEnabled(true)
    const before = renderMarkdown("`code`")
    setMarkdownColors({ code: "#ff0000" })
    const after = renderMarkdown("`code`")
    assert.notEqual(before, after)
    assert.match(after, /\[38;2;255;0;0m/)
  })
})
