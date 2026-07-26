import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import { thinkingPreviewLines, THINKING_PREVIEW_ROWS } from "../src/ui/thinking-preview.mjs"

/**
 * 0.6.2：思考中显示两行灰字的实时尾部。
 *
 * 此前只有一行 `Thinking · 5.1s` —— 你知道它在想，但不知道在想什么。
 * 完整思考又不能铺开：常常几百行，会把对话挤没。
 *
 * **行数必须恒定**是这里唯一的硬约束：帧的行数记账按块的实际行数计费，
 * 一个会变高的块会让对话区随模型输出上下抖动。
 */

describe("行数恒定", () => {
  it("无论输入多长多短，永远返回固定行数", () => {
    const cases = ["", "  ", "短", "一".repeat(500), "a\nb\nc\nd\ne\nf\ng"]
    for (const input of cases) {
      const lines = thinkingPreviewLines(input, 60)
      assert.equal(lines.length, THINKING_PREVIEW_ROWS, `输入 ${JSON.stringify(input.slice(0, 20))} 行数不对`)
    }
  })

  it("可以指定行数", () => {
    assert.equal(thinkingPreviewLines("abc", 60, 4).length, 4)
    assert.equal(thinkingPreviewLines("abc", 60, 1).length, 1)
  })

  it("空输入返回空行而不是 undefined", () => {
    assert.deepEqual(thinkingPreviewLines("", 60), ["", ""])
    assert.deepEqual(thinkingPreviewLines(null, 60), ["", ""])
  })
})

describe("显示的是尾部", () => {
  it("长文本只保留最后两行的量", () => {
    const long = Array.from({ length: 50 }, (_, i) => `segment-${i}`).join(" ")
    const lines = thinkingPreviewLines(long, 40)
    assert.ok(lines.at(-1).includes("segment-49"), `尾部应含最新内容: ${lines.at(-1)}`)
    assert.ok(!lines.join("").includes("segment-0"), "不该还留着最早的内容")
  })

  it("每行不超过给定宽度", () => {
    const long = "x".repeat(500)
    for (const line of thinkingPreviewLines(long, 30)) {
      assert.ok(line.length <= 30, `行超宽: ${line.length}`)
    }
  })

  it("换行被压平 —— 段落停顿不该让窗口一跳一跳", () => {
    const lines = thinkingPreviewLines("first\n\n\nsecond", 60)
    assert.ok(lines.join(" ").includes("first second"), `换行应压成空格: ${JSON.stringify(lines)}`)
  })
})

test("极窄宽度不会崩", () => {
  const lines = thinkingPreviewLines("some thinking text here", 1)
  assert.equal(lines.length, THINKING_PREVIEW_ROWS)
  assert.ok(lines.every((l) => typeof l === "string"))
})
