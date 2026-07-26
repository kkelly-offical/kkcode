import test from "node:test"
import assert from "node:assert/strict"
import { createKeyDispatcher } from "../src/repl/key-dispatch.mjs"
import { createEditorKeyScope } from "../src/repl/keys/editor-keys.mjs"
import { createLifecycleKeyScope, createScrollKeyScope } from "../src/repl/keys/global-keys.mjs"
import { createReplUiState } from "../src/repl/ui-state.mjs"

/**
 * 编辑器与全局按键的行为。
 *
 * 这三个作用域的排布本身就是规则：
 *
 *   lifecycle → 浮层 → scroll → 忙碌闸门 → editor
 *
 * `scroll` 刻意排在忙碌闸门之前 —— 模型正在生成时用户仍然要能往回翻。
 * `lifecycle` 排在所有东西之前 —— 浮层开着时也得能挂起与退出。
 * 拆分前这三条只体现为 685 行里的相对位置，没有任何东西能表达它们。
 */

const DOUBLE_ESCAPE_MS = 1200

function harness({ busy = false } = {}) {
  const calls = []
  const spy = (name) => (...args) => { calls.push(args.length ? `${name}(${args.join(",")})` : name) }
  const transcript = {
    items: [],
    getItems() { return this.items },
    toggleLog: spy("toggleLog"),
    clear: spy("clearTranscript")
  }
  const state = { mode: "agent", sessionId: "s" }
  const ui = createReplUiState()
  ui.busy = busy

  const deps = {
    requestRender: () => {},
    showToast: (message) => calls.push(`toast(${message})`),
    appendLog: () => calls.push("appendLog"),
    transcript,
    insertAtCursor: (text) => {
      ui.input = ui.input.slice(0, ui.inputCursor) + text + ui.input.slice(ui.inputCursor)
      ui.inputCursor += text.length
    },
    deleteInputSelection: () => false,
    moveCursor: (delta) => { ui.inputCursor = Math.max(0, Math.min(ui.input.length, ui.inputCursor + delta)) },
    setCursor: (pos) => { ui.inputCursor = pos },
    moveGraphemeCursor: (text, cursor, delta) => Math.max(0, Math.min(text.length, cursor + delta)),
    onInputChanged: () => {},
    acceptGhost: () => { calls.push("acceptGhost"); return Boolean(ui.ghostText) },
    cancelGhost: spy("cancelGhost"),
    // 三种候选（`/` 命令、`$` 技能、`@` 文件）在这张按键表眼里是同一件事：
    // 「有没有候选」。种类差异在 suggestion-source 里分派，不在这里。
    hasSuggestions: () => ui.input.startsWith("/") || /(^|\s)@/.test(ui.input),
    shouldApplySuggestionOnEnter: () => Boolean(ui._applySuggestion),
    applyCurrentSuggestion: spy("applySuggestion"),
    handleUpDownSuggestions: () => Boolean(ui._suggestionNav),
    navigateHistory: spy("navigateHistory"),
    submitCurrentInput: async () => { calls.push("submit") },
    requestExitIfQuitting: () => { if (ui.quitting) calls.push("exit") },
    cycleModeForwardAndNotify: spy("cycleMode"),
    handleRewind: spy("rewind"),
    readClipboardImage: async () => null,
    readClipboardText: async () => "",
    doubleEscapeMs: DOUBLE_ESCAPE_MS,
    finishSelection: spy("finishSelection"),
    copyToClipboard: spy("copyToClipboard"),
    suspendForJobControl: spy("suspend"),
    requestExit: spy("requestExit"),
    scrollBy: (n) => calls.push(`scrollBy(${n})`),
    scrollToTop: spy("scrollToTop"),
    scrollToBottom: spy("scrollToBottom"),
    pageSize: (rows) => Math.max(1, rows - 1),
    state
  }

  const { dispatchKey, describeOrder } = createKeyDispatcher({
    scopes: [
      createLifecycleKeyScope(deps),
      createScrollKeyScope(deps),
      createEditorKeyScope(deps)
    ]
  })
  return { dispatchKey, describeOrder, calls, ui, transcript }
}

const press = (name, extra = {}) => ({ key: { name, ...extra }, str: extra.str || "" })

// --- 作用域排布本身就是规则 ---

test("lifecycle comes first, then scroll, then the editor", () => {
  const { describeOrder } = harness()
  const order = describeOrder()
  const at = (id) => order.indexOf(id)
  assert.ok(at("lifecycle.suspend") < at("scroll.pageUp"), "挂起要能穿透一切")
  assert.ok(at("scroll.pageUp") < at("editor.insert"), "滚动排在编辑之前")
  assert.ok(at("scroll.pauseTurn") < at("editor.clearInput"),
    "忙碌时的 Esc 是中断，不是清空输入 —— 顺序反了就中断不了")
})

test("scrolling still works while the model is generating", async () => {
  // scroll 作用域刻意排在忙碌闸门之前
  const { dispatchKey, calls } = harness({ busy: true })
  const { ui } = harness({ busy: true })
  ui.busy = true
  ui.scrollMeta = { logRows: 10, totalRows: 100, maxOffset: 90 }
  await dispatchKey({ ui, ...press("pageup") })
  assert.ok(calls.some((c) => c.startsWith("scrollBy(")), "忙碌时也必须能往回翻")
})

test("the editor scope is inert while busy", async () => {
  const { dispatchKey, ui, calls } = harness({ busy: true })
  const result = await dispatchKey({ ui, key: {}, str: "a" })
  assert.equal(result.handled, false, "忙碌时按键不该改到输入框")
  assert.equal(ui.input, "")
  assert.deepEqual(calls, [])
})

// --- Ctrl+C 的三种含义 ---

test("Ctrl+C copies a selection, interrupts a turn, or exits on the second press", async () => {
  const withSelection = harness()
  withSelection.ui.mouseSelection = { startRow: 1 }
  await withSelection.dispatchKey({ ui: withSelection.ui, ...press("c", { ctrl: true }) })
  assert.deepEqual(withSelection.calls, ["finishSelection(true)"], "有选区时 Ctrl+C 是复制")

  const busy = harness({ busy: true })
  busy.ui.turnAbortController = { abort() { busy.calls.push("abort") } }
  await busy.dispatchKey({ ui: busy.ui, ...press("c", { ctrl: true }) })
  assert.ok(busy.calls.includes("abort"), "忙碌时 Ctrl+C 是中断")
  assert.equal(busy.ui.paused, true)

  const idle = harness()
  await idle.dispatchKey({ ui: idle.ui, ...press("c", { ctrl: true }) })
  assert.ok(idle.calls.some((c) => c.includes("again to exit")), "第一次只提示")
  await idle.dispatchKey({ ui: idle.ui, ...press("c", { ctrl: true }) })
  assert.ok(idle.calls.includes("requestExit"), "两秒内第二次才退出")
})

test("Ctrl+D exits only when the input box is empty", async () => {
  const empty = harness()
  await empty.dispatchKey({ ui: empty.ui, ...press("d", { ctrl: true }) })
  assert.ok(empty.calls.includes("requestExit"))

  const typed = harness()
  typed.ui.input = "abc"
  await typed.dispatchKey({ ui: typed.ui, ...press("d", { ctrl: true }) })
  assert.ok(!typed.calls.includes("requestExit"), "输入框有内容时 Ctrl+D 通常是想删字符")
})

// --- Esc 的三级语义 ---

test("Esc dismisses the ghost, then clears the input, then rewinds", async () => {
  const h = harness()
  h.ui.ghostText = "预测的内容"
  h.ui.input = "写了一半"
  await h.dispatchKey({ ui: h.ui, ...press("escape") })
  assert.equal(h.ui.ghostText, "", "第一级：撤掉 ghost")
  assert.equal(h.ui.input, "写了一半", "输入还在")

  await h.dispatchKey({ ui: h.ui, ...press("escape") })
  assert.equal(h.ui.input, "", "第二级：清空输入")

  await h.dispatchKey({ ui: h.ui, ...press("escape") })
  assert.ok(h.calls.some((c) => c.includes("回溯")), "第三级：提示再按一次")
  assert.ok(!h.calls.includes("rewind"), "单次不该直接回溯")

  await h.dispatchKey({ ui: h.ui, ...press("escape") })
  assert.ok(h.calls.includes("rewind"), "窗口内连按两次才回溯")
})

test("a stale Esc does not trigger a rewind", async () => {
  const h = harness()
  h.ui.lastEscapeAt = Date.now() - DOUBLE_ESCAPE_MS - 1000
  await h.dispatchKey({ ui: h.ui, ...press("escape") })
  assert.ok(!h.calls.includes("rewind"), "超出窗口应重新计时，而不是直接回溯")
})

// --- 编辑 ---

test("typing inserts, backspace deletes by grapheme", async () => {
  const h = harness()
  await h.dispatchKey({ ui: h.ui, key: {}, str: "中" })
  await h.dispatchKey({ ui: h.ui, key: {}, str: "文" })
  assert.equal(h.ui.input, "中文")
  await h.dispatchKey({ ui: h.ui, ...press("backspace") })
  assert.equal(h.ui.input, "中", "退格删整个字符，不是半个")
})

test("Home and End move the cursor when unmodified, and scroll when modified", async () => {
  const h = harness()
  h.ui.input = "一二三四"
  h.ui.inputCursor = 2
  await h.dispatchKey({ ui: h.ui, ...press("home") })
  assert.equal(h.ui.inputCursor, 0)
  await h.dispatchKey({ ui: h.ui, ...press("end") })
  assert.equal(h.ui.inputCursor, 4)

  await h.dispatchKey({ ui: h.ui, ...press("home", { ctrl: true }) })
  assert.ok(h.calls.includes("scrollToTop"), "Ctrl+Home 是滚到最早")
  assert.equal(h.ui.inputCursor, 4, "带修饰键时不该同时动光标")
})

test("Enter submits, Shift+Enter inserts a newline", async () => {
  const h = harness()
  h.ui.input = "问题"
  await h.dispatchKey({ ui: h.ui, ...press("return", { shift: true }) })
  assert.match(h.ui.input, /\n/, "Shift+Enter 换行")
  assert.ok(!h.calls.includes("submit"))

  await h.dispatchKey({ ui: h.ui, ...press("return") })
  assert.ok(h.calls.includes("submit"))
})

test("Enter takes a pending suggestion before it submits", async () => {
  const h = harness()
  h.ui._applySuggestion = true
  await h.dispatchKey({ ui: h.ui, ...press("return") })
  assert.ok(h.calls.includes("applySuggestion"))
  assert.ok(!h.calls.includes("submit"), "第一次 Enter 是选中候选，不是提交")
})

test("Tab prefers completion over the ghost", async () => {
  const withSlash = harness()
  withSlash.ui.input = "/he"
  withSlash.ui.ghostText = "预测"
  await withSlash.dispatchKey({ ui: withSlash.ui, ...press("tab") })
  assert.ok(withSlash.calls.includes("applySuggestion"))
  assert.ok(!withSlash.calls.includes("acceptGhost"), "有补全候选时 Tab 不该抢去接受 ghost")

  const noSlash = harness()
  noSlash.ui.input = "普通输入"
  noSlash.ui.ghostText = "预测"
  await noSlash.dispatchKey({ ui: noSlash.ui, ...press("tab") })
  assert.ok(noSlash.calls.includes("acceptGhost"))
})

test("Tab takes a file candidate mid-sentence, not the ghost", async () => {
  // `@` 候选可以出现在句子中间，而 Tab 的闸门此前问的是「输入是不是像命令」——
  // 那个判据对句中的 `@` 恒为假，于是 Tab 会去接受 ghost、把补全吃掉。
  const h = harness()
  h.ui.input = "看看 @src/rep"
  h.ui.inputCursor = h.ui.input.length
  h.ui.ghostText = "预测"
  await h.dispatchKey({ ui: h.ui, ...press("tab") })
  assert.ok(h.calls.includes("applySuggestion"))
  assert.ok(!h.calls.includes("acceptGhost"), "句中的 @ 候选同样该拦住 Tab")
})

test("Shift+Tab cycles the mode instead of completing", async () => {
  const h = harness()
  await h.dispatchKey({ ui: h.ui, ...press("tab", { shift: true }) })
  assert.deepEqual(h.calls, ["cycleMode"])
})

test("arrow keys walk the suggestions first and history second", async () => {
  const nav = harness()
  nav.ui._suggestionNav = true
  await nav.dispatchKey({ ui: nav.ui, ...press("up") })
  assert.ok(!nav.calls.includes("navigateHistory"), "有候选时上下键在候选里走")

  const history = harness()
  await history.dispatchKey({ ui: history.ui, ...press("up") })
  assert.ok(history.calls.includes("navigateHistory(up)"))
})

test("the view toggles do what they say", async () => {
  const h = harness()
  const before = h.ui.showDashboard
  await h.dispatchKey({ ui: h.ui, ...press("b", { ctrl: true }) })
  assert.equal(h.ui.showDashboard, !before)

  await h.dispatchKey({ ui: h.ui, ...press("y", { ctrl: true }) })
  assert.ok(h.calls.some((c) => c.includes("Auto-copy")))

  await h.dispatchKey({ ui: h.ui, ...press("l", { ctrl: true }) })
  assert.ok(h.calls.includes("clearTranscript"))
})

test("Ctrl+Shift+L is not a transcript clear", async () => {
  // 原来的条件带 `&& !key.shift` —— 保住它，否则组合键会误清屏
  const h = harness()
  await h.dispatchKey({ ui: h.ui, ...press("l", { ctrl: true, shift: true }) })
  assert.ok(!h.calls.includes("clearTranscript"))
})
