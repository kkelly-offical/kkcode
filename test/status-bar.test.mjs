import test, { describe, it, afterEach } from "node:test"
import assert from "node:assert/strict"
import { renderStatusBar, fitSegments, formatTokenCount, STATUS_SEGMENT_IDS } from "../src/theme/status-bar.mjs"
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

test("width is a parameter, so the caller's width is the one that matters", () => {
  // 0.6.1 修的是「装不下时丢哪个段」，但宽度仍直读 process.stdout.columns。
  // 后果在 0.7.0 抽出 frame-builder 时才暴露：帧按 86 列排，状态栏按
  // process.stdout（测试里是 120）排，超出部分被帧从右边硬切 —— 于是
  // 优先级机制根本没参与判断，被切掉的还是最右边的 PERMISSION。
  const args = {
    mode: "agent", modeId: "agent", model: "some-long-model-name",
    permission: "manual", theme: DEFAULT_THEME,
    tokenMeter: { estimated: false, turn: { input: 12345, output: 6789 }, session: { input: 99999, output: 88888 }, global: { input: 1234567, output: 7654321 } },
    cost: { session: 1.2345, turn: 0.0456 },
    contextMeter: { tokens: 95000, limit: 128000, ratio: 0.74, percent: 74 }
  }

  // 显式宽度必须压过 process.stdout.columns
  Object.defineProperty(process.stdout, "columns", { value: 200, configurable: true })
  const narrow = strip(renderStatusBar({ ...args, width: 86 }))
  const wide = strip(renderStatusBar({ ...args, width: 200 }))
  assert.notEqual(narrow, wide, "同一状态在两个宽度下必须排得不一样")

  for (const [label, line, width] of [["86 列", narrow, 86], ["200 列", wide, 200]]) {
    assert.ok(strip(line).length <= width, `${label}: 排版结果 ${strip(line).length} 字符，超过 ${width}`)
    assert.match(line, /PERMISSION/, `${label}: 权限段是优先级 0，永不丢弃`)
    assert.match(line, /AGENT/, `${label}: 模式段是优先级 0，永不丢弃`)
  }

  // 窄宽度下该丢的是低优先级段，而不是靠硬截断
  assert.doesNotMatch(narrow, /~$/, "不该出现硬截断标记 —— 那意味着优先级没起作用")
})

test("width falls back to process.stdout when the caller gives none", () => {
  // 既有调用方没传 width 时行为不变，避免这次改动变成隐式的破坏
  Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true })
  const withoutWidth = strip(renderStatusBar({
    mode: "agent", modeId: "agent", model: "m", permission: "yolo", theme: DEFAULT_THEME,
    tokenMeter: { estimated: false, turn: { input: 1, output: 1 }, session: { input: 1, output: 1 }, global: { input: 1, output: 1 } }
  }))
  const withWidth = strip(renderStatusBar({
    mode: "agent", modeId: "agent", model: "m", permission: "yolo", theme: DEFAULT_THEME,
    tokenMeter: { estimated: false, turn: { input: 1, output: 1 }, session: { input: 1, output: 1 }, global: { input: 1, output: 1 } },
    width: 120
  }))
  assert.equal(withoutWidth, withWidth)
})

// --- 可配置状态栏（0.8.1 ui.status.segments） ---

test("segments 配置决定显示哪些段与顺序", () => {
  const line = atWidth(200, { segments: ["permission", "model", "context"] })
  assert.ok(line.includes("PERMISSION"), "列了的段要在")
  assert.ok(line.includes("MODEL"), "列了的段要在")
  assert.ok(!line.includes("TOKENS"), "没列的段不显示")
  assert.ok(!line.includes("COST"), "没列的段不显示")
  assert.ok(line.indexOf("PERMISSION") < line.indexOf("MODEL"),
    "顺序按配置来，不按内置缺省 —— 配置的意义正在于此")
})

test("segments 为空或未配时行为与 0.8.0 完全一致", () => {
  const unset = atWidth(200)
  const empty = atWidth(200, { segments: [] })
  const explicitNull = atWidth(200, { segments: null })
  assert.equal(empty, unset, "空数组 = 不配（防手滑把状态栏配没了）")
  assert.equal(explicitNull, unset)
})

test("列了但当前不适用的段静默跳过，不渲染空壳", () => {
  // longagent 段只在 longagent 模式下建；memory 段只在 memoryLoaded 时建
  const line = atWidth(200, {
    segments: ["mode", "longagent", "memory", "permission"],
    memoryLoaded: false
  })
  assert.ok(!line.includes("LONG"), "非 longagent 模式下没有 LONG 段")
  assert.ok(!line.includes("MEM"), "memory 没加载时列了也不渲染")
  assert.ok(line.includes("PERMISSION"))
})

test("STATUS_SEGMENT_IDS 与渲染表同源 —— 每个 id 都真的能渲染出一个段", () => {
  // 枚举驱动：加了段名却没接渲染（或反之）时这条会红。逐个单独渲染，
  // 用「只列它 + 全量条件都满足」的输入证明它建得出来。
  const fullConditions = {
    memoryLoaded: true,
    longagentState: { currentStageId: "s1", phase: "code" },
    mode: "longagent"
  }
  for (const id of STATUS_SEGMENT_IDS) {
    const line = atWidth(200, { segments: [id], ...fullConditions })
    assert.ok(strip(line).trim().length > 0,
      `段 "${id}" 在条件满足时渲染不出任何内容 —— 清单与渲染表分叉了`)
  }
})

test("schema 拒绝未知段名，合法值与渲染清单同源", async () => {
  const { validateConfig } = await import("../src/config/schema.mjs")
  assert.equal(validateConfig({ ui: { status: { segments: ["mode", "permission"] } } }).valid, true)
  const bad = validateConfig({ ui: { status: { segments: ["mode", "nonsense"] } } })
  assert.equal(bad.valid, false)
  assert.ok(bad.errors.some((e) => e.includes("nonsense")), "报错要点名是哪个段写错了")
  assert.equal(validateConfig({ ui: { status: { segments: "mode" } } }).valid, false, "必须是数组")
})
