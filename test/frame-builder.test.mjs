import test from "node:test"
import assert from "node:assert/strict"
import { buildFrame } from "../src/repl/frame-builder.mjs"
import { displayWidth, stripAnsi } from "../src/repl/frame-primitives.mjs"
import { createThinkingState } from "../src/ui/thinking-state.mjs"
import { createTranscriptModel } from "../src/ui/transcript-model.mjs"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs"
import { PACKAGE_VERSION } from "../src/version.mjs"

/**
 * buildFrame 此前在 startTuiRepl 内部，宽高直接读 process.stdout —— 测试进程里
 * 那两个值恒为 undefined，于是所有分档逻辑一律走 120×40，宽度相关的行为从未被
 * 测过。0.6.1 的状态栏事故（86 列下 PERMISSION 段被截、整条状态栏溢出）就是
 * 这么漏过 1148 条测试的。
 *
 * 现在宽高与 now 都是参数，所以这里能做两件此前做不到的事：
 *   1. 在多个宽度下断言「每一行恰好占 width 个单元格」
 *   2. 逐个 UI 分支（权限提示、提问、三种选择器、思考、流式、选区）都走一遍 ——
 *      抽取时若漏掉某个自由变量，那个分支会立刻抛 ReferenceError，而不是等到
 *      用户真的打开那个浮层
 */

const THEME = DEFAULT_THEME

function makeUi(patch = {}) {
  return {
    input: "",
    inputCursor: 0,
    busy: false,
    pendingImages: [],
    permissionQueue: [],
    pendingPermission: null,
    permissionSelected: 0,
    questionQueue: [],
    pendingQuestion: null,
    questionIndex: 0,
    questionOptionSelected: 0,
    questionMultiSelected: {},
    questionCustomMode: false,
    questionCustomInput: "",
    questionCustomCursor: 0,
    questionAnswers: {},
    modelPicker: null,
    policyPicker: null,
    modePicker: null,
    themePicker: null,
    selectedSuggestion: 0,
    suggestionOffset: 0,
    scrollOffset: 0,
    showDashboard: false,
    scrollMeta: { logRows: 0, totalRows: 0, maxOffset: 0 },
    spinnerIndex: 0,
    currentActivity: null,
    currentStep: 0,
    maxSteps: 0,
    thinking: createThinkingState(),
    paused: false,
    mouseSelection: null,
    inputSelection: null,
    ghostText: "",
    inputLayout: null,
    layoutMeta: { logStartRow: 0, logEndRow: 0, inputStartRow: 0, inputEndRow: 0 },
    metrics: {
      tokenMeter: { estimated: false, turn: { input: 0, output: 0 }, session: { input: 0, output: 0 }, global: { input: 0, output: 0 } },
      cost: null,
      context: null,
      longagent: null,
      toolEvents: []
    },
    ...patch
  }
}

function makeCtx() {
  return {
    themeState: { theme: THEME },
    // 用真实默认配置而非手搓的残缺对象：状态栏会读 usage/permission/agent 等
    // 多个分支，手搓的版本每加一个配置项就会假失败一次。
    configState: { config: structuredClone(DEFAULT_CONFIG) }
  }
}

function render(uiPatch = {}, { width = 120, height = 40, transcriptItems = [], suggestions } = {}) {
  const transcript = createTranscriptModel({ maxItems: 200 })
  for (const item of transcriptItems) transcript.append(item)
  return buildFrame({
    ui: makeUi(uiPatch),
    ctx: makeCtx(),
    state: { mode: "agent", model: "test-model", sessionId: "s1" },
    transcript,
    width,
    height,
    // 候选表是**算好的**传进来的（0.7.1 起）。此前这里传的是 `slashOptions`，
    // buildFrame 自己再调一次 slashSuggestions —— 那是全仓第四处独立求值。
    suggestions,
    applySelectionHighlight: (frameLines) => frameLines,
    renderToastLine: () => null,
    now: 1_700_000_000_000
  })
}

/** 文件候选表，形状与 suggestion-source.compute() 的返回值一致。 */
function fileSuggestions(names, extra = {}) {
  return {
    kind: "mention",
    sigil: "@",
    query: "rep",
    items: names.map((name) => ({ name, desc: "", matched: [] })),
    total: names.length,
    truncated: false,
    maxFiles: 20000,
    ...extra
  }
}

/** 每一行都必须恰好是 width 个单元格 —— 少一格就是边框错位，多一格就是换行溢出。 */
function assertExactWidth(frame, width, label) {
  frame.lines.forEach((line, index) => {
    const w = displayWidth(stripAnsi(line))
    assert.equal(w, width, `${label}: 第 ${index + 1} 行宽 ${w}，应为 ${width}\n  内容: ${JSON.stringify(stripAnsi(line).slice(0, 60))}`)
  })
}

const WIDTHS = [60, 80, 86, 100, 120, 200]

test("every line is exactly the terminal width, at every width", () => {
  for (const width of WIDTHS) {
    const frame = render({}, { width })
    assert.ok(frame.lines.length > 0, `${width} 列下应有内容`)
    assertExactWidth(frame, width, `空闲态 @ ${width}`)
  }
})

test("86 columns — the width that broke the status bar in 0.6.1", () => {
  // 那次是状态栏为了给新增的绝对 token 数腾位置，把 PERMISSION 段截掉了，
  // 而 86 列下整条状态栏在更早的版本就已经溢出。
  const frame = render({
    metrics: {
      tokenMeter: { estimated: false, turn: { input: 12345, output: 6789 }, session: { input: 99999, output: 88888 }, global: { input: 1234567, output: 7654321 } },
      cost: { session: 1.2345, turn: 0.0456 },
      context: { tokens: 95000, limit: 128000, ratio: 0.74, percent: 74 },
      longagent: null,
      toolEvents: []
    }
  }, { width: 86 })
  assertExactWidth(frame, 86, "满载指标 @ 86")
  const text = frame.lines.map(stripAnsi).join("\n")
  assert.match(text, /MANUAL|manual/i, "权限档位不能被挤掉 —— 它是永不丢弃的段")
})

test("CJK content does not shift the frame", () => {
  // 宽字符裁剪落在字符中间时会少一格，整行随之左移。中文界面里这是常态输入。
  for (const width of [60, 86, 120]) {
    const frame = render({ input: "把这个目录整理一下，按类型分到子目录里去" }, { width })
    assertExactWidth(frame, width, `中文输入 @ ${width}`)
  }
})

test("each overlay branch renders — a missed closure variable would throw here", () => {
  const branches = {
    权限提示: {
      pendingPermission: {
        tool: "write", pattern: "src/a.mjs", command: "", risk: 0,
        reason: "写入工作区文件", resolve: () => {}
      },
      permissionSelected: 0
    },
    单选提问: {
      pendingQuestion: {
        questions: [{ question: "选哪个方案？", header: "方案", multiSelect: false,
          options: [{ label: "A 方案", description: "先做最小可用" }, { label: "B 方案", description: "先做完整版" }] }],
        resolve: () => {}
      }
    },
    多选提问: {
      pendingQuestion: {
        questions: [{ question: "启用哪些功能？", header: "功能", multiSelect: true,
          options: [{ label: "缓存", description: "开启缓存" }, { label: "压缩", description: "开启压缩" }] }],
        resolve: () => {}
      },
      questionMultiSelected: { 0: new Set([0]) }
    },
    自定义答案: {
      pendingQuestion: {
        questions: [{ question: "填个值", header: "值", multiSelect: false, options: [{ label: "默认", description: "用默认值" }] }],
        resolve: () => {}
      },
      questionCustomMode: true,
      questionCustomInput: "自己填的内容",
      questionCustomCursor: 6
    },
    模型选择器: {
      modelPicker: { items: [{ id: "k3", label: "k3", desc: "1M 上下文" }, { id: "qwen", label: "qwen", desc: "视觉" }], selected: 0, offset: 0 }
    },
    模式选择器: { modePicker: { selected: 0 } },
    策略选择器: { policyPicker: { selected: 0 } },
    // 主题选择器的候选是运行期算出来的（dark/light/auto + 可选的文件主题），
    // 所以它画的是状态里的 items，不像模式/策略那样读模块常量。
    主题选择器: {
      themePicker: {
        items: [
          { id: "dark", label: "dark", desc: "深色背景（默认）", current: true },
          { id: "light", label: "light", desc: "浅色背景" },
          { id: "auto", label: "auto", desc: "跟随终端背景（OSC 11 探测）" }
        ],
        selected: 1,
        restore: "dark"
      }
    },
    忙碌与思考: {
      busy: true,
      currentActivity: { type: "tool", tool: "bash", args: { command: "npm test" } },
      currentStep: 3,
      maxSteps: 10,
      thinking: { ...createThinkingState(), active: true, startedAt: 1_699_999_990_000, text: "在想一件事" }
    },
    暂停态: { paused: true, busy: true },
    // 0.7.0 前这里喂的是 ui.pendingImages（渲染成 `[2 img]` 前缀）。附件改成输入文本里
    // 的内联标记之后，那个字段没人读了 —— 继续喂它就是一条对着空气成立的用例。
    带附件标记: { input: "看这两张 [Image #1] [Image #2] 有什么区别", inputCursor: 12 },
    仪表盘: { showDashboard: true },
    输入框选区: { input: "选中一段文字", inputCursor: 3, inputSelection: { start: 1, end: 4 } }
  }

  for (const [name, patch] of Object.entries(branches)) {
    for (const width of [60, 120]) {
      let frame
      assert.doesNotThrow(() => { frame = render(patch, { width }) }, `${name} @ ${width} 不该抛错`)
      assert.ok(frame.lines.length > 0, `${name} @ ${width} 应有内容`)
      assertExactWidth(frame, width, `${name} @ ${width}`)
    }
  }
})

test("排队中的消息数显示在提示行上，且不新增一行", () => {
  // 计数挂在已有的提示行上而不是自己起一行：帧按块的实际行数记账，
  // 一个时有时无的行会让对话区随排队与否上下跳。
  const idle = render({})
  const queued = render({ queuedPrompts: ["一", "二"] })
  assert.equal(queued.lines.length, idle.lines.length, "排队不该改变帧的行数")

  const text = queued.lines.map(stripAnsi).join("\n")
  assert.match(text, /2 queued/, "排队数必须看得见，否则用户不知道自己排的东西还在不在")
  assert.doesNotMatch(idle.lines.map(stripAnsi).join("\n"), /queued/, "没排队时不该占用提示行的宽度")

  for (const width of [60, 120]) assertExactWidth(render({ queuedPrompts: ["一"] }, { width }), width, `排队提示 @ ${width}`)
})

test("transcript content is clipped, not allowed to overflow", () => {
  const items = [
    { id: "1", kind: "text", role: "assistant", text: "x".repeat(400) },
    { id: "2", kind: "text", role: "user", text: "中".repeat(200) },
    { id: "3", kind: "text", role: "assistant", text: `${String.fromCharCode(27)}]8;;http://example.com${String.fromCharCode(7)}link${String.fromCharCode(27)}]8;;${String.fromCharCode(7)}` }
  ]
  for (const width of [60, 86, 120]) {
    const frame = render({}, { width, transcriptItems: items })
    assertExactWidth(frame, width, `长内容与超链接 @ ${width}`)
  }
})

test("the frame fits the terminal height", () => {
  for (const height of [12, 24, 40, 60]) {
    const frame = render({ showDashboard: true }, { width: 100, height })
    assert.ok(frame.lines.length <= height, `${height} 行的终端不该产出 ${frame.lines.length} 行`)
  }
})

test("a tiny terminal still produces a usable frame", () => {
  // 极窄/极矮不该崩，也不该产出负宽度的行
  for (const [width, height] of [[40, 10], [30, 8], [20, 6]]) {
    let frame
    assert.doesNotThrow(() => { frame = render({}, { width, height }) }, `${width}x${height}`)
    assertExactWidth(frame, width, `极小终端 ${width}x${height}`)
    assert.ok(frame.lines.length <= height)
  }
})

test("the frame is deterministic — same state and clock give the same lines", () => {
  // now 提成参数之前，思考计时会让每次输出都不同，没法做快照式断言
  const patch = { busy: true, thinking: { ...createThinkingState(), active: true, startedAt: 1_699_999_990_000 } }
  const a = render(patch, { width: 100 })
  const b = render(patch, { width: 100 })
  assert.deepEqual(a.lines, b.lines)
})

test("the cursor stays inside the frame", () => {
  for (const width of WIDTHS) {
    const frame = render({ input: "一些输入内容", inputCursor: 3 }, { width })
    assert.ok(frame.cursor, `${width} 列下应给出光标位置`)
    assert.ok(frame.cursor.col >= 1 && frame.cursor.col <= width, `光标列 ${frame.cursor.col} 越界 @ ${width}`)
    assert.ok(frame.cursor.row >= 1, `光标行 ${frame.cursor.row} 越界 @ ${width}`)
  }
})

test("omitting now uses the real clock instead of throwing", () => {
  // 抽取时 `Date.now()` 被全局替换成 `now`，连参数默认值 `now = Date.now()`
  // 自己也被改成了 `now = now` —— TDZ 错误，而且只在**省略** now 时触发。
  // repl.mjs 正是省略它的那个调用方，所以单测全绿、e2e 才崩。
  // 这条用例走默认值路径，把那类错误挡在单测层。
  const transcript = createTranscriptModel({ maxItems: 10 })
  let frame
  assert.doesNotThrow(() => {
    frame = buildFrame({
      ui: makeUi({ busy: true, thinking: { ...createThinkingState(), active: true, startedAt: Date.now() - 3000 } }),
      ctx: makeCtx(),
      state: { mode: "agent", model: "test-model", sessionId: "s1" },
      transcript,
      width: 100,
      height: 30,
      applySelectionHighlight: (l) => l,
      renderToastLine: () => null
      // now 与 suggestions 有意不传
    })
  })
  assertExactWidth(frame, 100, "省略 now")
})

test("a file candidate list still fills every line exactly, at every width", () => {
  // 文件路径比命令名长得多，而候选行此前只画过 `padRight(name, 14)` 的命令名。
  // 一条长路径把候选行撑过帧宽的话，整帧的边框会当场错位。
  const suggestions = fileSuggestions([
    "src/repl/keys/editor-keys.mjs",
    "src/repl/suggestion-source.mjs",
    "README.md"
  ])
  for (const width of WIDTHS) {
    const frame = render({ input: "看看 @src/rep", inputCursor: 12 }, { width, suggestions })
    assertExactWidth(frame, width, `文件候选 @ ${width}`)
  }
})

test("the file candidate list reaches the frame", () => {
  const frame = render(
    { input: "看看 @src/rep", inputCursor: 12 },
    { suggestions: fileSuggestions(["src/repl.mjs", "README.md"]) }
  )
  const text = frame.lines.map((line) => stripAnsi(line)).join("\n")
  assert.match(text, /Files \(1\/2\)/)
  assert.match(text, /@src\/repl\.mjs/)
})

test("the candidate block carries its own title — no hardcoded 'Commands' header", () => {
  // 此前候选块上面还有一行写死的 "Commands"：对文件候选是错的，对命令候选是重复的
  // （下一行就是 "Slash Commands (1/1) …"）。
  const frame = render(
    { input: "/he", inputCursor: 3 },
    {
      suggestions: {
        kind: "slash",
        sigil: "/",
        query: "he",
        items: [{ name: "help", desc: "show help" }],
        total: 1,
        truncated: false,
        maxFiles: 0
      }
    }
  )
  const lines = frame.lines.map((line) => stripAnsi(line).trim())
  assert.ok(lines.some((line) => line.startsWith("Slash Commands (1/1)")), "命令候选的标题还在")
  assert.equal(lines.filter((line) => line === "Commands").length, 0)
})

test("no candidates means no candidate rows", () => {
  const frame = render({ input: "普通输入", inputCursor: 4 })
  const text = frame.lines.map((line) => stripAnsi(line)).join("\n")
  assert.doesNotMatch(text, /Files \(/)
  assert.doesNotMatch(text, /Slash Commands \(/)
})

test("版本号右对齐在底部提示行末端，与快捷键提示同一行", () => {
  const frame = render({}, { width: 120 })
  const footer = stripAnsi(frame.lines.at(-1))
  assert.match(footer, /↵ send/, "左侧快捷键提示还在")
  assert.ok(footer.endsWith(`v${PACKAGE_VERSION}`), `末行应以版本号结尾: ${JSON.stringify(footer)}`)
  assertExactWidth(frame, 120, "版本号右对齐 @ 120")
})

test("窄终端让版本号让位而不是溢出", () => {
  const versionPattern = new RegExp(`v${PACKAGE_VERSION.replaceAll(".", "\\.")}`)
  for (const [width, height] of [[40, 10], [30, 8], [20, 6]]) {
    const frame = render({}, { width, height })
    assertExactWidth(frame, width, `窄宽版本让位 @ ${width}`)
    assert.doesNotMatch(stripAnsi(frame.lines.at(-1)), versionPattern, `${width} 列下不该硬塞版本号`)
  }
})

test("busy 状态行按实际阶段显示对应文案，而不是统一 Thinking", () => {
  const frameText = (patch, width = 120) => {
    const frame = render({ busy: true, ...patch }, { width })
    assertExactWidth(frame, width, `busy 状态 @ ${width}`)
    return frame.lines.map(stripAnsi).join("\n")
  }
  const thinkingBase = { currentActivity: { type: "thinking" } }

  // 提交后空窗：回合已忙但第一个 step 事件还没到。此前显示 Thinking · 0.0s（冻结）。
  const starting = frameText({})
  assert.match(starting, /Starting\.+/, "空窗期是 Starting")
  assert.doesNotMatch(starting, /0\.0s/, "没有计时锚点就不该摆一个冻结的 0.0s")

  // longagent 阶段间隙：同样没有 currentActivity，但它不是「刚启动」
  const working = frameText({ metrics: { ...makeUi().metrics, longagent: { phase: "build" } } })
  assert.match(working, /Working\.+/, "longagent 间隙是 Working")

  // 等首个 token：phase=waiting 有锚点，带计时
  const waiting = frameText({
    ...thinkingBase,
    thinking: { ...createThinkingState(), phase: "waiting", startedAt: 1_699_999_990_000 }
  })
  assert.match(waiting, /Waiting\.+\s+· 10s/, "等首 token 是 Waiting 且计时")
  assert.doesNotMatch(waiting, /Thinking/, "等待与推理不能混为一个词")

  // 工具结束到下一 step 的间隙：activity=thinking 但 phase 已回 idle，无锚点不计时
  const gap = frameText({ ...thinkingBase })
  assert.match(gap, /Waiting\.+/, "step 间隙仍是 Waiting")
  assert.doesNotMatch(gap, /0\.0s/, "无锚点间隙不该显示 0.0s")

  // 推理流：真正的 thinking 内容在到达
  const thinking = frameText({
    ...thinkingBase,
    thinking: { ...createThinkingState(), phase: "streaming", startedAt: 1_699_999_990_000 }
  })
  assert.match(thinking, /Thinking\.+\s+· 10s/, "推理流才是 Thinking")

  // provider 重试：次数与原因都要看得见
  const retry = frameText({ currentActivity: { type: "retry", attempt: 2, max: 5, classification: "timeout" } })
  assert.match(retry, /Retrying 2\/5\.+/, "重试要带进度")
  assert.match(retry, /· timeout/, "重试要带原因")

  // 上下文压缩
  assert.match(frameText({ currentActivity: { type: "compacting" } }), /Compacting\.+/)

  // 正文流与工具：原有行为保持
  assert.match(frameText({ currentActivity: { type: "writing" } }), /writing/)
  assert.match(frameText({ currentActivity: { type: "tool", tool: "bash", args: { command: "npm test" } } }), /bash/)

  // 窄宽下所有状态都不溢出
  for (const patch of [{}, thinkingBase, { currentActivity: { type: "retry", attempt: 2, max: 5, classification: "timeout" } }, { currentActivity: { type: "compacting" } }]) {
    frameText(patch, 60)
  }
})

test("thinking 点数动画不推动计时：· 的列位置跨帧固定", () => {
  // 此前 dots 是 1~3 个点的变宽字符串，· 03s 随点数左右横跳。
  // 补到固定 3 格之后，无论 spinnerIndex 是多少，· 必须停在同一列。
  const thinkingAt = (spinnerIndex) => {
    const frame = render({
      busy: true,
      currentActivity: { type: "thinking" },
      spinnerIndex,
      thinking: { ...createThinkingState(), active: true, phase: "streaming", startedAt: 1_699_999_990_000 }
    }, { width: 120 })
    const line = frame.lines.map(stripAnsi).find((l) => l.includes("Thinking"))
    assert.ok(line, "推理流帧里应有 Thinking 行")
    return line
  }
  const a = thinkingAt(0)
  const b = thinkingAt(2)
  assert.equal(a.indexOf("·"), b.indexOf("·"), "· 的列位置不能随点数动画漂移")
  assert.match(a, /Thinking\.\s+·/, "spinnerIndex 0 是 1 个点")
  assert.match(b, /Thinking\.{3} ·/, "spinnerIndex 2 是 3 个点")
})
