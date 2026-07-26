import test from "node:test"
import assert from "node:assert/strict"
import {
  createReplUiState,
  openUserOverlay,
  closeUserOverlay,
  closeAllUserOverlays,
  activeUserOverlay,
  USER_OVERLAY_KINDS,
  PROMPT_OVERLAY_KINDS
} from "../src/repl/ui-state.mjs"
import { buildFrame } from "../src/repl/frame-builder.mjs"
import { createTranscriptModel } from "../src/ui/transcript-model.mjs"
import { displayWidth, stripAnsi } from "../src/repl/frame-primitives.mjs"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs"

/**
 * 浮层互斥不变量。
 *
 * 拆分前六个浮层是六个各自独立的可空字段，谁都能直接赋值；`repl.mjs` 里有一条
 * 注释声称 infoPanel「与选择器互斥」，但没有任何代码保证。
 *
 * 而 frame-builder 的浮层是**叠加**的 —— 每个非空块都拼进帧，行数相加。两个
 * 浮层同开时两个都画，对话区被挤到最小的 2 行，而按键只有一个生效（按键的
 * 优先级顺序和渲染顺序还不一样）。这是可达的：`/provider` 开着选择器时，
 * 后台任务的 question 提示会异步到达。
 */

function overlayValue(kind) {
  const items = [{ id: "a", label: "甲", desc: "" }, { id: "b", label: "乙", desc: "" }]
  if (kind === "infoPanel") return { title: "t", lines: ["x"], offset: 0, maxOffset: 0, maxRows: 8 }
  if (kind === "modePicker" || kind === "policyPicker") return { selected: 0 }
  return { items, selected: 0, offset: 0 }
}

test("a fresh state has no overlay open", () => {
  const ui = createReplUiState()
  assert.equal(activeUserOverlay(ui), null)
  for (const kind of USER_OVERLAY_KINDS) assert.equal(ui[kind], null, `${kind} 应为 null`)
})

test("opening any overlay closes the other five", () => {
  for (const kind of USER_OVERLAY_KINDS) {
    const ui = createReplUiState()
    // 先把六个全打开（模拟拆分前谁都能直接赋值的状态）
    for (const other of USER_OVERLAY_KINDS) ui[other] = overlayValue(other)
    openUserOverlay(ui, kind, overlayValue(kind))
    assert.equal(activeUserOverlay(ui), kind)
    const stillOpen = USER_OVERLAY_KINDS.filter((k) => ui[k])
    assert.deepEqual(stillOpen, [kind], `开 ${kind} 之后应只剩它一个，实际还有 ${stillOpen.join(", ")}`)
  }
})

test("the invariant covers every overlay kind, derived not hand-listed", () => {
  // 枚举驱动：新增一个浮层字段只要进了 USER_OVERLAY_KINDS，上面那条就自动覆盖它。
  // 手写清单在字段增长时会静默漏掉新来的那个。
  const ui = createReplUiState()
  for (const kind of USER_OVERLAY_KINDS) {
    assert.ok(kind in ui, `${kind} 不在状态里 —— 清单和状态对不上`)
  }
  assert.ok(USER_OVERLAY_KINDS.length >= 6)
})

test("tool-driven prompts are not cleared by the overlay invariant", () => {
  // 权限与提问提示是工具执行**在等回答**，有自己的队列。被顺手关掉就等于
  // 把那次工具调用永远挂住。
  const ui = createReplUiState()
  ui.pendingPermission = { tool: "write", resolve: () => {} }
  ui.pendingQuestion = { questions: [], resolve: () => {} }
  openUserOverlay(ui, "infoPanel", overlayValue("infoPanel"))
  closeAllUserOverlays(ui)
  for (const kind of PROMPT_OVERLAY_KINDS) {
    assert.ok(ui[kind], `${kind} 不该被用户浮层的互斥规则清掉`)
  }
})

test("closing an overlay leaves the others alone", () => {
  const ui = createReplUiState()
  openUserOverlay(ui, "modelPicker", overlayValue("modelPicker"))
  closeUserOverlay(ui, "infoPanel")   // 关一个本来没开的
  assert.equal(activeUserOverlay(ui), "modelPicker", "关掉别的浮层不该顺带关掉开着的那个")
  closeUserOverlay(ui, "modelPicker")
  assert.equal(activeUserOverlay(ui), null)
})

test("a line-mode providerPicker is a numbered-input state, not an overlay", () => {
  // 行模式（无 TTY）把 ui.providerPicker 设成字符串数组，表示「等用户输编号」。
  // 那不是浮层，frame-builder 也是靠 Array.isArray(items) 区分的。
  const ui = createReplUiState()
  ui.providerPicker = ["kimi-code", "aliyun"]
  assert.equal(activeUserOverlay(ui), null, "编号输入态不该被当成浮层")
})

test("an unknown overlay kind is a programming error, not a silent no-op", () => {
  const ui = createReplUiState()
  assert.throws(() => openUserOverlay(ui, "notAnOverlay", {}), /unknown overlay kind/)
})

// --- 渲染层：不变量成立时，帧里至多一个用户浮层 ---

test("the frame stacks overlays, which is why the invariant matters", () => {
  // 这条把「为什么需要不变量」钉下来：两个浮层同开时 frame-builder 会把两个都画出来，
  // 对话区被挤掉。如果哪天渲染改成互斥，这条会红 —— 那时不变量才可以放宽。
  const transcript = createTranscriptModel({ maxItems: 50 })
  for (let i = 0; i < 30; i++) transcript.append({ id: `i${i}`, kind: "text", role: "assistant", text: `第 ${i} 行` })

  function rowsWith(patch) {
    const ui = createReplUiState()
    Object.assign(ui, patch)
    const frame = buildFrame({
      ui,
      ctx: { themeState: { theme: DEFAULT_THEME }, configState: { config: structuredClone(DEFAULT_CONFIG) } },
      state: { mode: "agent", model: "m", sessionId: "s" },
      transcript,
      width: 100,
      height: 32,
      slashOptions: { builtinSlash: [], customCommands: [], skills: [] },
      applySelectionHighlight: (l) => l,
      renderToastLine: () => null,
      now: 1_700_000_000_000
    })
    frame.lines.forEach((line, i) =>
      assert.equal(displayWidth(stripAnsi(line)), 100, `第 ${i + 1} 行宽度不对`))
    return frame.lines.map(stripAnsi).join("\n")
  }

  const oneOverlay = rowsWith({ modelPicker: overlayValue("modelPicker") })
  assert.match(oneOverlay, /Select Model/)

  const twoOverlays = rowsWith({
    modelPicker: overlayValue("modelPicker"),
    infoPanel: overlayValue("infoPanel")
  })
  // 两个都出现 —— 这正是问题所在
  assert.match(twoOverlays, /Select Model/, "选择器画出来了")
  assert.match(twoOverlays, /Esc close/, "信息浮层也画出来了 —— 两个叠着")
})

test("with the invariant applied, only one overlay can reach the frame", () => {
  const ui = createReplUiState()
  openUserOverlay(ui, "modelPicker", overlayValue("modelPicker"))
  openUserOverlay(ui, "infoPanel", overlayValue("infoPanel"))
  const transcript = createTranscriptModel({ maxItems: 10 })
  const frame = buildFrame({
    ui,
    ctx: { themeState: { theme: DEFAULT_THEME }, configState: { config: structuredClone(DEFAULT_CONFIG) } },
    state: { mode: "agent", model: "m", sessionId: "s" },
    transcript,
    width: 100,
    height: 32,
    slashOptions: { builtinSlash: [], customCommands: [], skills: [] },
    applySelectionHighlight: (l) => l,
    renderToastLine: () => null,
    now: 1_700_000_000_000
  })
  const text = frame.lines.map(stripAnsi).join("\n")
  assert.doesNotMatch(text, /Select Model/, "后开的浮层应该把先开的关掉")
  assert.match(text, /Esc close/)
})
