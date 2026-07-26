import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { renderPanelOverlay, panelWindow } from "../src/ui/overlay-panel.mjs"
import { buildFrame } from "../src/repl/frame-builder.mjs"
import { clipAnsiLine, wrapLogLines, displayWidth, stripAnsi } from "../src/repl/frame-primitives.mjs"
import { paint } from "../src/theme/color.mjs"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs"
import { createThinkingState } from "../src/ui/thinking-state.mjs"
import { createTranscriptModel } from "../src/ui/transcript-model.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/**
 * 只读信息浮层。
 *
 * 此前 `/status`、`/permission`、`/help` 这类**查询当前状态**的输出走
 * `channel: "panel"`，折叠成对话记录里的一条条目。0.6.0 那次改动解决了
 * 「80 行帮助刷屏」，但把这些输出留在了对话历史里，于是：
 *
 *   1. 它们会随会话一起发给模型 —— 那是给人看的，不是给模型看的
 *   2. `/clear` 会把它们连带清掉，而它们跟对话内容无关
 *   3. 看完关不掉，只能往下滚过去
 */

function panelArgs(overrides = {}) {
  return {
    title: "runtime status",
    lines: Array.from({ length: 30 }, (_, i) => `line ${i + 1}`),
    width: 80,
    maxRows: 10,
    theme: DEFAULT_THEME,
    paint,
    clipAnsiLine,
    wrapLines: (lines, w) => wrapLogLines(lines, w),
    ...overrides
  }
}

test("panel lines are exactly the requested width", () => {
  for (const width of [40, 60, 86, 120, 200]) {
    const { lines } = renderPanelOverlay(panelArgs({ width }))
    lines.forEach((line, i) => {
      assert.equal(displayWidth(stripAnsi(line)), width, `宽 ${width} 第 ${i + 1} 行`)
    })
  }
})

test("panel height stays stable while scrolling", () => {
  // 内容不足时补空行 —— 否则每次滚动边框都在跳
  const first = renderPanelOverlay(panelArgs({ offset: 0 }))
  const last = renderPanelOverlay(panelArgs({ offset: 999 }))
  assert.equal(first.lines.length, last.lines.length)
})

test("a short panel does not scroll and says so", () => {
  const { lines, maxOffset } = renderPanelOverlay(panelArgs({ lines: ["only one line"], maxRows: 10 }))
  assert.equal(maxOffset, 0)
  const text = lines.map(stripAnsi).join("\n")
  assert.match(text, /Esc close/)
  assert.doesNotMatch(text, /scroll/, "不可滚动时不该提示滚动键")
})

test("a long panel shows its position and offers scroll keys", () => {
  const { lines, maxOffset } = renderPanelOverlay(panelArgs({ offset: 5 }))
  assert.ok(maxOffset > 0)
  const text = lines.map(stripAnsi).join("\n")
  assert.match(text, /6-15\/30/, "标题要带 当前范围/总行数")
  assert.match(text, /↑↓ scroll/)
})

test("offset is clamped, so a stale offset cannot blank the panel", () => {
  const beyond = renderPanelOverlay(panelArgs({ offset: 10_000 }))
  assert.equal(beyond.offset, beyond.maxOffset)
  const text = beyond.lines.map(stripAnsi).join("\n")
  assert.match(text, /line 30/, "夹到末尾时应显示最后一行")

  const negative = renderPanelOverlay(panelArgs({ offset: -50 }))
  assert.equal(negative.offset, 0)
})

test("panelWindow reports the scrollable range", () => {
  assert.deepEqual(panelWindow({ total: 30, offset: 0, maxVisible: 10 }), { start: 0, end: 10, visible: 10, maxOffset: 20 })
  assert.deepEqual(panelWindow({ total: 5, offset: 0, maxVisible: 10 }), { start: 0, end: 5, visible: 5, maxOffset: 0 })
  assert.deepEqual(panelWindow({ total: 30, offset: 25, maxVisible: 10 }), { start: 20, end: 30, visible: 10, maxOffset: 20 })
})

test("CJK content in a panel does not shift the border", () => {
  const { lines } = renderPanelOverlay(panelArgs({
    lines: ["权限档位：手动确认", "非交互默认：拒绝", "已配置规则（3 条）"],
    width: 60
  }))
  lines.forEach((line, i) => assert.equal(displayWidth(stripAnsi(line)), 60, `第 ${i + 1} 行`))
})

// --- 帧集成 ---

function makeUi(patch = {}) {
  return {
    input: "", inputCursor: 0, busy: false, pendingImages: [], permissionQueue: [],
    pendingPermission: null, permissionSelected: 0, questionQueue: [], pendingQuestion: null,
    questionIndex: 0, questionOptionSelected: 0, questionMultiSelected: {}, questionCustomMode: false,
    questionCustomInput: "", questionCustomCursor: 0, questionAnswers: {}, modelPicker: null,
    policyPicker: null, modePicker: null, providerPicker: null, infoPanel: null,
    selectedSuggestion: 0, suggestionOffset: 0, scrollOffset: 0, showDashboard: false,
    scrollMeta: { logRows: 0, totalRows: 0, maxOffset: 0 }, spinnerIndex: 0,
    currentActivity: null, currentStep: 0, maxSteps: 0, thinking: createThinkingState(),
    paused: false, mouseSelection: null, inputSelection: null, ghostText: "", inputLayout: null,
    layoutMeta: { logStartRow: 0, logEndRow: 0, inputStartRow: 0, inputEndRow: 0 },
    metrics: {
      tokenMeter: { estimated: false, turn: { input: 0, output: 0 }, session: { input: 0, output: 0 }, global: { input: 0, output: 0 } },
      cost: null, context: null, longagent: null, toolEvents: []
    },
    ...patch
  }
}

function renderFrame(uiPatch, { width = 100, height = 40 } = {}) {
  return buildFrame({
    ui: makeUi(uiPatch),
    ctx: { themeState: { theme: DEFAULT_THEME }, configState: { config: structuredClone(DEFAULT_CONFIG) } },
    state: { mode: "agent", model: "test-model", modeId: "agent", providerType: "kimi-code", sessionId: "s1" },
    transcript: createTranscriptModel({ maxItems: 50 }),
    width, height,
    slashOptions: { builtinSlash: [], customCommands: [], skills: [] },
    applySelectionHighlight: (l) => l, renderToastLine: () => null, now: 1_700_000_000_000
  })
}

test("the info panel appears in the frame and clamps its own offset", () => {
  const ui = { infoPanel: { title: "runtime status", lines: Array.from({ length: 40 }, (_, i) => `row ${i}`), offset: 9_999, maxRows: 10 } }
  const frame = renderFrame(ui)
  const text = frame.lines.map(stripAnsi).join("\n")
  assert.match(text, /runtime status/)
  assert.match(text, /Esc close/)
  frame.lines.forEach((line, i) => assert.equal(displayWidth(stripAnsi(line)), 100, `第 ${i + 1} 行`))
})

test("the provider picker renders as an overlay, marking the current channel", () => {
  // 此前 /provider 把编号列表打进对话记录，然后进「输入编号」模式 ——
  // 配置渠道是个选择动作，理应和 /model 一样是可视化选择器。
  const frame = renderFrame({
    providerPicker: {
      items: [
        { name: "kimi-code", label: "kimi-code", desc: "model: k3" },
        { name: "aliyun", label: "aliyun", desc: "model: qwen3.7-plus" }
      ],
      selected: 1,
      offset: 0
    }
  })
  const text = frame.lines.map(stripAnsi).join("\n")
  assert.match(text, /Select Provider \(2\/2\)/)
  assert.match(text, /aliyun/)
  assert.match(text, /Esc cancel/)
  frame.lines.forEach((line, i) => assert.equal(displayWidth(stripAnsi(line)), 100, `第 ${i + 1} 行`))
})

test("a string-array providerPicker (line mode) does not render an overlay", () => {
  // 行模式把 ui.providerPicker 设成字符串数组（编号输入态）。那种形态没有
  // items 字段，不该被当成浮层渲染 —— 否则 map 会在 undefined 上炸。
  let frame
  assert.doesNotThrow(() => { frame = renderFrame({ providerPicker: ["kimi-code", "aliyun"] }) })
  assert.doesNotMatch(frame.lines.map(stripAnsi).join("\n"), /Select Provider/)
})

// --- 通道契约 ---
//
// 「哪些命令走浮层」现在由 test/repl-commands.test.mjs 用**行为**断言覆盖
// （真的调用命令，看它往哪个通道写）。这里只留下两条仍然属于 repl.mjs 的性质。

test("the folded-panel channel survives only as showInfo's line-mode fallback", async () => {
  const src = await readFile(path.join(ROOT, "src", "repl.mjs"), "utf8")
  // `channel: "panel"` 是 0.6.0 的旧通道：它把输出折叠成**对话记录里的一条**，
  // 于是只读查询仍会随会话发给模型、被 /clear 清掉。唯一正当的残留是行模式
  // （无 TTY，没有帧可浮）的回落。多出一处就说明有命令又走回了对话记录。
  const panelCalls = src.split("\n").filter((line) => {
    const trimmed = line.trim()
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false
    return trimmed.includes('channel: "panel"')
  })
  assert.equal(panelCalls.length, 1,
    `channel: "panel" 只该保留在 showInfo 的行模式回落里，实际 ${panelCalls.length} 处：\n${panelCalls.join("\n")}`)
})

test("every usage message in the command layer is a toast", async () => {
  // 枚举驱动，不是手写清单：命令模块里**所有** `usage:` 文案都必须走 notice 通道。
  // 「usage: …」是对被拒命令的反馈，不是对话内容 —— 进对话记录就会被发给模型。
  // 手写要检查哪几条文案的话，下一条新命令的 usage 就会静默漏掉。
  const modules = ["session", "provider", "permission", "mode", "authoring"]
  const offenders = []
  for (const name of modules) {
    const src = await readFile(path.join(ROOT, "src", "repl", "commands", `${name}.mjs`), "utf8")
    for (const match of src.matchAll(/print\(\s*(["`])usage:[\s\S]{0,200}?\)\n/g)) {
      if (!/channel: "notice"/.test(match[0])) {
        offenders.push(`${name}.mjs: ${match[0].split("\n")[0].trim()}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `这些 usage 文案没走 notice 通道:\n  ${offenders.join("\n  ")}`)
})

test("showInfo falls back to a folded entry when there is no frame", async () => {
  const src = await readFile(path.join(ROOT, "src", "repl.mjs"), "utf8")
  // 行模式（无 TTY）没有帧可以浮，此时必须回落而不是静默丢弃输出
  const fn = src.slice(src.indexOf("function showInfo("), src.indexOf("function showInfo(") + 600)
  assert.match(fn, /if \(openPanel\)/, "有浮层时走浮层")
  assert.match(fn, /channel: "panel"/, "没有浮层时回落到折叠面板")
})

test("the session picker renders as an overlay and marks the current session", () => {
  // 裸 /resume 是「列出并选一个」，和 /provider 同构 —— 此前它打一份编号列表
  // 到对话记录，然后要用户手敲 /resume <编号>。
  const frame = renderFrame({
    sessionPicker: {
      items: [
        { id: "ses_aaa", label: "把工具层做到同行水平", desc: "agent · active · 5m ago" },
        { id: "s1", label: "整理目录", desc: "agent · done · 1h ago" }
      ],
      selected: 0,
      offset: 0
    }
  })
  const text = frame.lines.map(stripAnsi).join("\n")
  assert.match(text, /Resume Session \(1\/2\)/)
  assert.match(text, /Enter resume/)
  assert.match(text, /把工具层做到同行水平/)
  frame.lines.forEach((line, i) => assert.equal(displayWidth(stripAnsi(line)), 100, `第 ${i + 1} 行`))
})

test("pickers confirm through the normal submit path, not a second copy of the logic", async () => {
  const src = await readFile(path.join(ROOT, "src", "repl.mjs"), "utf8")
  // 切渠道要重取模型目录、校验凭据；续跑要恢复渠道、模型、历史。那些逻辑
  // 只应存在一处 —— 选择器确认时把命令填进输入框走正常提交，而不是复制一份。
  for (const [fn, command] of [["confirmProviderPicker", "/provider "], ["confirmSessionPicker", "/resume "]]) {
    const body = src.slice(src.indexOf(`async function ${fn}(`))
    const scoped = body.slice(0, body.indexOf("\n  }") + 4)
    assert.match(scoped, new RegExp(`ui\\.input = \`${command.replace("/", "\\/")}`), `${fn} 应复用提交路径`)
    assert.match(scoped, /await submitCurrentInput\(\)/, `${fn} 应走 submitCurrentInput`)
  }
})

test("action confirmations are toasts, not conversation", async () => {
  // 「刚发生了什么」类的确认不是对话内容 —— 进了对话记录就会随会话发给模型。
  // 这两条需要真实的注册表初始化/配置落盘才能行为覆盖，所以仍靠源码断言；
  // 但锚点必须**确认找得到**，否则搬家之后会变成空洞通过（见下一条的教训）。
  const src = await readFile(path.join(ROOT, "src", "repl", "commands", "permission.mjs"), "utf8")
  for (const literal of ["workspace trusted", "no matching always-allow rule"]) {
    const idx = src.indexOf(literal)
    assert.notEqual(idx, -1, `找不到文案：${literal} —— 它搬走了，这条断言需要跟着更新`)
    assert.match(src.slice(idx, idx + 220), /channel: "notice"/, `「${literal}」应走 notice 通道`)
  }
})

test("model replies and file changes stay in the conversation", async () => {
  // 反向保护：模型回复、文件变更、诊断是对话的一部分，不该被顺手改成瞬时提示 ——
  // 瞬时提示会消失，而这些内容用户需要回看。
  //
  // 这条断言此前锚在 repl.mjs 上。回合呈现搬进 turn-presenter.mjs 之后
  // `indexOf` 返回 -1，`slice(-1)` 只剩一个字符，`doesNotMatch` 于是**空洞通过** ——
  // 测试还在绿着，但什么都没验。所以现在每个锚点都先断言找得到。
  const src = await readFile(path.join(ROOT, "src", "repl", "turn-presenter.mjs"), "utf8")
  for (const [anchor, label] of [
    ["mdEnabled ? renderMarkdown(result.reply)", "模型回复"],
    ['paint("changed files:"', "文件变更"],
    ['paint("diagnostics:"', "诊断"]
  ]) {
    const idx = src.indexOf(anchor)
    assert.notEqual(idx, -1, `找不到锚点「${anchor}」—— 代码搬走了，这条断言需要跟着更新`)
    assert.doesNotMatch(src.slice(idx, idx + 160), /channel: "notice"/, `${label}必须留在对话记录里`)
  }
})
