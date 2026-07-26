import test, { describe, it, afterEach } from "node:test"
import assert from "node:assert/strict"
import { renderStatusBar, fitSegments, formatTokenCount } from "../src/theme/status-bar.mjs"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"

/**
 * 0.6.0：状态栏必须装得下。
 *
 * 这批断言来自一次真实终端验收 —— 在 110 列的 xterm 里，被硬截断掉的
 * 恰好是 PERMISSION（「agent 能不能不问就改文件」），为的是给 CONTEXT
 * 新增的绝对 token 数让位。86 列下更是整条状态栏本来就装不下。
 *
 * 此前 renderStatusBar 只是把段落拼起来交给调用方从右边切，顺序是历史
 * 形成的、与重要性无关，而且宽度分档从来没被测过（函数直读
 * process.stdout.columns，测试进程里恒为 undefined）。
 */

const ESC = String.fromCharCode(27)
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g")
const strip = (s) => String(s).replace(SGR, "")

const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns")
afterEach(() => {
  if (originalColumns) Object.defineProperty(process.stdout, "columns", originalColumns)
  else delete process.stdout.columns
})

function atWidth(cols, overrides = {}) {
  Object.defineProperty(process.stdout, "columns", { value: cols, configurable: true })
  return strip(renderStatusBar({
    mode: "agent",
    model: "k3",
    permission: "manual",
    tokenMeter: {
      turn: { input: 10000, output: 10289 },
      session: { input: 10000, output: 10289 },
      global: { input: 10000, output: 10289 }
    },
    cost: 0.0622,
    showCost: true,
    showTokenMeter: true,
    memoryLoaded: true,
    theme: DEFAULT_THEME,
    contextMeter: { tokens: 20289, limit: 1048576, ratio: 0.02, percent: 2 },
    ...overrides
  }))
}

describe("状态栏在任何宽度下都装得下", () => {
  for (const cols of [70, 86, 100, 110, 120, 160]) {
    it(`${cols} 列不溢出`, () => {
      const bar = atWidth(cols)
      assert.ok(bar.length <= cols, `${cols} 列渲染出 ${bar.length} 字符: ${bar}`)
    })
  }
})

describe("挤不下时丢弃的是装饰，不是安全信号", () => {
  it("最窄的终端里权限档依然可见", () => {
    for (const cols of [70, 86, 110]) {
      assert.match(atWidth(cols), /PERMISSION/, `${cols} 列丢掉了权限档`)
    }
  })

  it("上下文占用同样保留 —— 它决定你还能聊多久", () => {
    for (const cols of [70, 86, 110]) {
      assert.match(atWidth(cols), /CONTEXT|CTX/, `${cols} 列丢掉了上下文`)
    }
  })

  it("宽终端上装饰性段落照常出现", () => {
    const wide = atWidth(160)
    assert.match(wide, /COST/)
    assert.match(wide, /TOKENS/)
    assert.match(wide, /MEM/)
  })

  it("窄终端优先丢成本与内存这类装饰", () => {
    const narrow = atWidth(70)
    assert.doesNotMatch(narrow, /MEM/)
  })
})

describe("fitSegments 的取舍规则", () => {
  const seg = (text, priority) => ({ text, priority })

  it("按优先级数字从大到小丢弃", () => {
    const out = fitSegments([seg("AAA", 0), seg("BBB", 5), seg("CCC", 9)], 8, " ")
    assert.equal(out, "AAA BBB")
  })

  it("优先级 0 的段永不丢弃，宁可溢出", () => {
    const out = fitSegments([seg("AAAAA", 0), seg("BBBBB", 0)], 4, " ")
    assert.equal(out, "AAAAA BBBBB", "两个都不可丢时应当接受溢出")
  })

  it("量长度时剥掉 SGR —— 颜色不占屏幕宽度", () => {
    const colored = `${ESC}[31mAAA${ESC}[0m`
    const out = fitSegments([seg(colored, 0), seg("BBB", 9)], 8, " ")
    assert.equal(out, `${colored} BBB`, "带色文本的可见宽度应按 3 计")
  })

  it("装得下时一个都不丢", () => {
    const out = fitSegments([seg("AA", 1), seg("BB", 9)], 80, " ")
    assert.equal(out, "AA BB")
  })
})

test("formatTokenCount 的三个量级", () => {
  assert.equal(formatTokenCount(950), "950")
  assert.equal(formatTokenCount(193400), "193.4K")
  assert.equal(formatTokenCount(1250000), "1.3M")
})
