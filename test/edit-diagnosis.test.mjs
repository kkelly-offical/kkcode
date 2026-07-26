import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import { diagnoseNoMatch, findClosestBlock, guardProportion } from "../src/tool/edit-diagnosis.mjs"

/**
 * 0.7.0 阶段 2：编辑失败要能自纠。
 *
 * `edit` 零匹配此前只返回两个词 `no match`。模型拿到它唯一能做的是重读整个
 * 文件再猜一次 —— 最贵的自我纠正路径，而且经常反复失败。
 *
 * 调研五家前沿工具，这一点上分野最明显：Roo Code 回传相似度 + 带行号的最接近
 * 匹配 + 周边原文 + 下一步，Aider 用 SequenceMatcher 做同样的事，而 Claude
 * Code 与 Codex 都不给候选。这里抄的是前者。
 */

const FILE = [
  "export function greet(name) {",
  "  const message = `hello ${name}`",
  "    return message",
  "}",
  "",
  "export function farewell(name) {",
  "  return `bye ${name}`",
  "}"
].join("\n")

describe("最接近匹配的定位", () => {
  it("找到相似块并给出 1-based 行号", () => {
    const best = findClosestBlock(FILE, "  return message")
    assert.ok(best)
    assert.equal(best.startLine, 3, "应当指向实际那一行")
    assert.ok(best.similarity > 0.9)
  })

  it("完全不相干的片段不硬给候选", () => {
    assert.equal(findClosestBlock(FILE, "class DatabaseConnectionPool {}"), null)
  })

  it("多行片段按块比对", () => {
    const best = findClosestBlock(FILE, "export function farewell(name) {\n  return `bye ${name}`")
    assert.ok(best)
    assert.equal(best.startLine, 6)
    assert.equal(best.similarity, 1)
  })
})

describe("诊断文本要能让模型一轮改对", () => {
  it("只差空白时明确说出来 —— 这是最常见的失配原因", () => {
    const out = diagnoseNoMatch({ path: "greet.mjs", content: FILE, before: "  return message" })
    assert.match(out, /whitespace or indentation/)
    assert.match(out, /copy the exact bytes/)
  })

  it("给出相似度百分比与起始行号", () => {
    const out = diagnoseNoMatch({ path: "greet.mjs", content: FILE, before: "  const msg = `hi ${name}`" })
    assert.match(out, /\d+% similar, starting at line 2/)
  })

  it("给出带行号的最接近匹配与周边原文", () => {
    const out = diagnoseNoMatch({ path: "greet.mjs", content: FILE, before: "  const msg = `hi ${name}`" })
    assert.match(out, /Best Match Found:/)
    assert.match(out, /Surrounding Content:/)
    // 行号必须在，模型要靠它定位
    assert.match(out, /\s2→ {2}const message/)
  })

  it("总是说清文件多少行、片段多少行 —— 即使没有候选", () => {
    const out = diagnoseNoMatch({ path: "greet.mjs", content: FILE, before: "class DatabaseConnectionPool {}" })
    assert.match(out, /File length: 8 lines/)
    assert.match(out, /Your snippet: 1 line\(s\)/)
    assert.match(out, /none above 50% similarity/)
    assert.match(out, /grep/, "没有候选时应当引导去搜索")
  })

  it("诊断本身绝不抛错 —— 它出现在失败路径上，不能把失败变成崩溃", () => {
    for (const before of ["", "\n", "x".repeat(5000)]) {
      assert.doesNotThrow(() => diagnoseNoMatch({ path: "f", content: FILE, before }))
    }
    assert.doesNotThrow(() => diagnoseNoMatch({ path: "f", content: "", before: "a" }))
  })
})

describe("不成比例匹配守卫", () => {
  it("小片段匹配到大得多的块时拒绝", () => {
    assert.equal(guardProportion("a\nb", FILE), true)
  })

  it("同规模的匹配放行", () => {
    assert.equal(guardProportion("  return message", "    return message"), false)
  })

  it("单行片段只按行数判，不按长度判（沿用 opencode 的取舍）", () => {
    // opencode 的原实现里 `if (oldLines === 1) return false` —— 单行片段
    // 匹配到单行内容一律放行，哪怕长度差很多。理由是单行的宽松匹配（去空白、
    // 归一化引号）本来就可能命中一条长得多的行，按长度拦会误杀。
    // 跨行才是真正危险的方向：那意味着吞掉了额外的语句。
    assert.equal(guardProportion("short", "a much longer single line but still one line"), false)
    assert.equal(guardProportion("short", "x".repeat(3000)), false)
  })

  it("单行片段匹配到多行内容会被拦 —— 跨行才是危险方向", () => {
    assert.equal(guardProportion("short", "line one\nline two\nline three\nline four"), true)
  })
})

test("守卫目前无调用点 —— 它是为将来引入宽松匹配预备的闸门", () => {
  // 精确匹配不需要它。留在这里是因为：一旦引入任何宽松匹配，最危险的失败
  // 不是「匹配不到」（会报错、可恢复），而是「匹配到一个大得多的块然后
  // 静默整块替换」—— 不可逆的数据损失，且模型不会察觉。
  assert.equal(typeof guardProportion, "function")
})
