import test from "node:test"
import assert from "node:assert/strict"
import { buildFrame } from "../src/repl/frame-builder.mjs"
import { displayWidth, stripAnsi } from "../src/repl/frame-primitives.mjs"
import { createThinkingState } from "../src/ui/thinking-state.mjs"
import { createTranscriptModel } from "../src/ui/transcript-model.mjs"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs"

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

function render(uiPatch = {}, { width = 120, height = 40, transcriptItems = [] } = {}) {
  const transcript = createTranscriptModel({ maxItems: 200 })
  for (const item of transcriptItems) transcript.append(item)
  return buildFrame({
    ui: makeUi(uiPatch),
    ctx: makeCtx(),
    state: { mode: "agent", model: "test-model", sessionId: "s1" },
    transcript,
    width,
    height,
    slashOptions: { builtinSlash: [], customCommands: [], skills: [] },
    applySelectionHighlight: (frameLines) => frameLines,
    renderToastLine: () => null,
    now: 1_700_000_000_000
  })
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
    忙碌与思考: {
      busy: true,
      currentActivity: { tool: "bash", args: { command: "npm test" } },
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
      slashOptions: { builtinSlash: [], customCommands: [], skills: [] },
      applySelectionHighlight: (l) => l,
      renderToastLine: () => null
      // now 有意不传
    })
  })
  assertExactWidth(frame, 100, "省略 now")
})
