import test, { describe, it, afterEach } from "node:test"
import assert from "node:assert/strict"
import { paint, setColorEnabled, isColorEnabled } from "../src/theme/color.mjs"
import { renderMarkdown } from "../src/theme/markdown.mjs"

/**
 * 0.5.8：让配色在 CI 里可观测。
 *
 * `paint()` 原本直读 `process.stdout.isTTY`，测试进程不是 TTY 所以恒返回
 * 原文 —— 意味着**任何配色回归在 CI 里完全看不见**：结构改错会红，颜色改错
 * 不会。这批断言存在的意义就是把那扇门打开，让 0.6.0 的配色工作有落点。
 */

afterEach(() => setColorEnabled(null))

describe("上色开关", () => {
  it("显式打开后 paint 真的输出 SGR 序列", () => {
    setColorEnabled(false)
    assert.equal(paint("hello", "#ff0000"), "hello")

    setColorEnabled(true)
    const painted = paint("hello", "#ff0000")
    assert.match(painted, /\[38;2;255;0;0m/)
    assert.match(painted, /hello/)
    assert.match(painted, /\[0m$/)
  })

  it("逐调用的 enabled 覆盖优先于全局开关", () => {
    setColorEnabled(false)
    assert.match(paint("x", "#00ff00", { enabled: true }), /\[38;2;0;255;0m/)
    setColorEnabled(true)
    assert.equal(paint("x", "#00ff00", { enabled: false }), "x")
  })

  it("setColorEnabled(null) 还原为跟随环境", () => {
    setColorEnabled(true)
    assert.equal(isColorEnabled(), true)
    setColorEnabled(null)
    // 测试进程非 TTY —— 还原后应当回到不上色
    assert.equal(isColorEnabled(), Boolean(process.stdout.isTTY) && !process.env.NO_COLOR)
  })

  it("样式位（bold/dim/italic/underline）同样受开关控制", () => {
    setColorEnabled(false)
    assert.equal(paint("t", null, { bold: true }), "t")
    setColorEnabled(true)
    assert.match(paint("t", null, { bold: true }), /\[1m/)
  })
})

describe("markdown 渲染跟随同一个开关", () => {
  it("删除线是手写 SGR，也必须跟随开关而不是各判各的", () => {
    setColorEnabled(false)
    assert.doesNotMatch(renderMarkdown("~~gone~~"), /\[9m/)

    setColorEnabled(true)
    assert.match(renderMarkdown("~~gone~~"), /\[9m/)
  })

  it("打开开关后 markdown 元素确实带色（配色断言从此可写）", () => {
    setColorEnabled(true)
    const rendered = renderMarkdown("# 标题\n\n`code`\n")
    assert.match(rendered, /\[/, "至少要有一段 SGR 序列")
  })
})
