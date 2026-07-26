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
 *   lifecycle → 浮层 → scroll → editor
 *
 * `scroll` 刻意排在 `editor` 之前 —— 模型正在生成时用户仍然要能往回翻，而且
 * 忙碌时的 Esc 必须是「中断回合」而不是编辑器那三级 Esc 里的任何一级。
 * `lifecycle` 排在所有东西之前 —— 浮层开着时也得能挂起与退出。
 * 拆分前这三条只体现为 685 行里的相对位置，没有任何东西能表达它们。
 *
 * 0.7.2 起 `editor` 作用域**不再整体挂忙碌闸门**：输入框忙碌时照常可编辑，
 * Enter 改为排队。原先那一句 `!ui.busy` 一次性挡住的东西，现在每条各自挡，
 * 下面「忙碌时哪些键该失效」一节逐条钉住。
 */

const DOUBLE_ESCAPE_MS = 1200

// `silentQueue` 而不是 `queueAck = true` + 传 undefined：传 undefined 会触发默认值，
// 桩照样返回 true，那条用例就成了空洞的绿。
function harness({ busy = false, silentQueue = false } = {}) {
  const calls = []
  const queued = []
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
    // 真删，不是返回 false 的桩：删除类按键的优先级（有选区先删选区）只有在
    // 选区真的被删掉时才测得出来
    deleteInputSelection: () => {
      const sel = ui.inputSelection
      if (!sel || sel.start === sel.end) return false
      const start = Math.min(sel.start, sel.end)
      const end = Math.max(sel.start, sel.end)
      ui.input = ui.input.slice(0, start) + ui.input.slice(end)
      ui.inputCursor = start
      ui.inputSelection = null
      calls.push("deleteInputSelection")
      return true
    },
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
    // 照着 repl/prompt-outbox.mjs 的 `queue` 建模：**同步**，去空白与上限都归它。
    // 上限在桩里压到 2，好把「队列满了」这条测出来。
    // 它今天在拒绝时返回 false —— handler 只认这个严格的 false（见下面那条用例）。
    queuePrompt: (text) => {
      const value = String(text || "").trim()
      if (!value) return false
      if (queued.length >= 2) { calls.push("queueFull"); return false }
      queued.push(value)
      calls.push(`queue(${value})`)
      return silentQueue ? undefined : true
    },
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

  // 单独留一份 editor 作用域：有几条要绕开前面的作用域，直接问「editor 自己挡不挡」
  const editorScope = createEditorKeyScope(deps)
  const { dispatchKey, describeOrder } = createKeyDispatcher({
    scopes: [
      createLifecycleKeyScope(deps),
      createScrollKeyScope(deps),
      editorScope
    ]
  })
  return { dispatchKey, describeOrder, calls, ui, transcript, editorScope, queued }
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

// --- 忙碌时：输入框是活的，但回合相关的键要各自挡住 ---

test("the input box stays editable while the model is working", async () => {
  // 0.7.2 之前整个作用域挂着 `!ui.busy`：模型一开始干活，用户敲的每个字符都被
  // 丢弃，想到下一句只能盯着 spinner 干等。
  const h = harness({ busy: true })
  await h.dispatchKey({ ui: h.ui, key: {}, str: "下" })
  await h.dispatchKey({ ui: h.ui, key: {}, str: "一" })
  assert.equal(h.ui.input, "下一", "忙碌时敲的字符不该被丢弃")

  await h.dispatchKey({ ui: h.ui, ...press("backspace") })
  assert.equal(h.ui.input, "下", "忙碌时也得能改错字")
})

test("Enter queues instead of submitting while busy", async () => {
  const h = harness({ busy: true })
  h.ui.input = "顺便把测试也跑一遍"
  h.ui.inputCursor = h.ui.input.length
  const result = await h.dispatchKey({ ui: h.ui, ...press("return") })
  assert.equal(result.handler, "submit", "键仍由 submit 接住，只是含义变了")
  assert.ok(h.calls.includes("queue(顺便把测试也跑一遍)"), "忙碌时 Enter 是排队")
  assert.ok(!h.calls.includes("submit"), "忙碌时 Enter 绝不能真提交 —— 那是并发发起第二个回合")
  assert.equal(h.ui.input, "", "排完队清空，好接着打下一句")
  assert.equal(h.ui.inputCursor, 0)
})

test("an empty Enter while busy queues nothing", async () => {
  const h = harness({ busy: true })
  h.ui.input = "   "
  await h.dispatchKey({ ui: h.ui, ...press("return") })
  assert.deepEqual(h.queued, [], "空白输入排队没有意义")
  assert.ok(!h.calls.includes("submit"))
})

test("a refused queue leaves the typed text in the box", async () => {
  // 队列满（或输入为空）时 queuePrompt 明确返回 false。**那时不能清空输入框** ——
  // 清了的话用户刚打的一段话既没排上队也没了，而提示只说了「队列已满」。
  // 只认严格的 false：返回 undefined 时照常清空，那是「返回值无意义」的实现。
  const h = harness({ busy: true })
  h.ui.input = "第一条"
  await h.dispatchKey({ ui: h.ui, ...press("return") })
  h.ui.input = "第二条"
  await h.dispatchKey({ ui: h.ui, ...press("return") })
  h.ui.input = "第三条挤不进去了"
  h.ui.inputCursor = h.ui.input.length
  await h.dispatchKey({ ui: h.ui, ...press("return") })

  assert.deepEqual(h.queued, ["第一条", "第二条"])
  assert.ok(h.calls.includes("queueFull"))
  assert.equal(h.ui.input, "第三条挤不进去了", "没排进去的文本必须留在输入框里")
  assert.equal(h.ui.inputCursor, 8, "光标也别乱动")
})

test("Enter still submits when idle", async () => {
  const h = harness()
  h.ui.input = "问题"
  await h.dispatchKey({ ui: h.ui, ...press("return") })
  assert.ok(h.calls.includes("submit"))
  assert.ok(!h.calls.some((c) => c.startsWith("queue(")), "空闲时不该走排队")
})

test("a queuePrompt that returns nothing still clears the box", async () => {
  // 约定的契约是「返回值忽略」。所以只有**严格的 false** 算拒绝，`undefined` 照常
  // 清空 —— 否则哪天 queue 改成什么都不返回，输入框就再也清不掉了。
  const h = harness({ busy: true, silentQueue: true })
  h.ui.input = "排一条"
  h.ui.inputCursor = 3
  await h.dispatchKey({ ui: h.ui, ...press("return") })
  assert.deepEqual(h.queued, ["排一条"])
  assert.equal(h.ui.input, "", "没有明确拒绝就该清空")
})

test("Ctrl+L does not clear the transcript mid-turn", async () => {
  // 回合还在往 transcript 里写：清掉之后增量落进一张空表，用户既看不到这一回合的
  // 开头，也无从判断它是不是还在跑
  const h = harness({ busy: true })
  await h.dispatchKey({ ui: h.ui, ...press("l", { ctrl: true }) })
  assert.ok(!h.calls.includes("clearTranscript"), "回合进行中不该清屏")
  assert.ok(h.calls.some((c) => c.includes("Turn in progress")), "要说明为什么没反应")

  const idle = harness()
  await idle.dispatchKey({ ui: idle.ui, ...press("l", { ctrl: true }) })
  assert.ok(idle.calls.includes("clearTranscript"), "空闲时照常清屏")
})

test("Shift+Tab does not switch modes mid-turn, and does not leak into completion", async () => {
  const h = harness({ busy: true })
  const result = await h.dispatchKey({ ui: h.ui, ...press("tab", { shift: true }) })
  assert.equal(result.handler, "cycleMode",
    "键必须仍被 cycleMode 接住 —— 放它落到 tabComplete 上，忙碌时 Shift+Tab 会变成补全")
  assert.ok(!h.calls.includes("cycleMode"), "模式决定这一回合怎么走，中途不能换")
  assert.ok(!h.calls.includes("applySuggestion"))
})

test("Esc while busy interrupts the turn — it never reaches the editor's Esc levels", async () => {
  // 作用域顺序 lifecycle → 浮层 → scroll → editor 是这条的唯一保障：
  // `scroll.pauseTurn` 排在 editor 之前，所以三级 Esc 忙碌时都到不了。
  const h = harness({ busy: true })
  h.ui.turnAbortController = { abort() { h.calls.push("abort") } }
  const result = await h.dispatchKey({ ui: h.ui, ...press("escape") })
  assert.equal(result.scope, "scroll")
  assert.equal(result.handler, "pauseTurn")
  assert.ok(h.calls.includes("abort"))
  assert.ok(!h.calls.includes("rewind"), "回合进行中 Esc 不该回溯")
})

test("a rewind is refused mid-turn even if the Esc gets past pauseTurn", async () => {
  // 第二道闸：直接把 editor 作用域单独拿出来分派，绕开 scroll.pauseTurn。
  // 回溯改的是会话历史，而正在跑的回合还引用着它 —— 不该只靠「谁排在前面」兜着。
  const h = harness({ busy: true })
  const editorOnly = createKeyDispatcher({ scopes: [h.editorScope] })
  h.ui.lastEscapeAt = Date.now()
  const result = await editorOnly.dispatchKey({ ui: h.ui, ...press("escape") })
  assert.ok(!h.calls.includes("rewind"), "忙碌时的回溯必须被处理器自己挡住")
  assert.notEqual(result.handler, "rewind")
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

// --- emacs 行编辑（0.7.2）---
//
// 光标算术本身在 test/repl-line-editing 里测（48 条）。这里只测**接线**：
// 哪个键调哪个函数、顺序有没有被别的处理器抢走、选区优先级还在不在。

test("Ctrl+A and Ctrl+E stay inside the current logical line", async () => {
  // Shift+Enter 会在 ui.input 里放真的 `\n`，所以「行首」必须是逻辑行的行首。
  // 实现成 setCursor(0) / setCursor(input.length) 的话这条会红。
  const h = harness()
  h.ui.input = "第一行\n第二行"
  h.ui.inputCursor = 6

  await h.dispatchKey({ ui: h.ui, ...press("a", { ctrl: true }) })
  assert.equal(h.ui.inputCursor, 4, "Ctrl+A 停在第二行行首，不是整段输入的开头")

  await h.dispatchKey({ ui: h.ui, ...press("e", { ctrl: true }) })
  assert.equal(h.ui.inputCursor, 7, "Ctrl+E 到第二行行尾")

  h.ui.inputCursor = 1
  await h.dispatchKey({ ui: h.ui, ...press("e", { ctrl: true }) })
  assert.equal(h.ui.inputCursor, 3, "第一行的行尾在换行符之前，不会跳过换行")
})

test("Ctrl+E no longer toggles the details block — Ctrl+O carries it alone", async () => {
  // 行为变更：Ctrl+E 此前与 Ctrl+O 并列绑定在「展开/折叠最近的可展开块」上
  const h = harness()
  h.transcript.items = [{ id: "t1", kind: "tool", collapsible: true, details: ["x"], expanded: false }]
  h.ui.input = "abc"
  h.ui.inputCursor = 0

  const result = await h.dispatchKey({ ui: h.ui, ...press("e", { ctrl: true }) })
  assert.equal(result.handler, "logicalLineEnd")
  assert.ok(!h.calls.some((c) => c.startsWith("toggleLog")), "Ctrl+E 现在是行尾，不再展开折叠")
  assert.equal(h.ui.inputCursor, 3)

  // 直接问 toggleDetails 的谓词认不认 Ctrl+E。只测分派结果的话，这条会被「谁排在
  // 前面」兜住 —— 行尾恰好排在展开折叠之前，于是即使谓词里 `e` 还在也照样绿。
  const toggleDetails = h.editorScope.handlers.find((entry) => entry.id === "toggleDetails")
  assert.equal(toggleDetails.when({ ui: h.ui, key: { ctrl: true, name: "e" }, str: "" }), false,
    "Ctrl+E 必须从 toggleDetails 的谓词里真的去掉")
  assert.equal(toggleDetails.when({ ui: h.ui, key: { ctrl: true, name: "o" }, str: "" }), true)

  await h.dispatchKey({ ui: h.ui, ...press("o", { ctrl: true }) })
  assert.ok(h.calls.some((c) => c.startsWith("toggleLog")), "Ctrl+O 仍然展开折叠")
})

test("Alt+B and Alt+F move by word", async () => {
  const h = harness()
  h.ui.input = "hello world"
  h.ui.inputCursor = 11

  const back = await h.dispatchKey({ ui: h.ui, ...press("b", { meta: true }) })
  assert.equal(back.handler, "wordLeft", "Alt+B 不能被 Ctrl+B 的仪表盘开关接走")
  assert.equal(h.ui.inputCursor, 6)

  await h.dispatchKey({ ui: h.ui, ...press("b", { meta: true }) })
  assert.equal(h.ui.inputCursor, 0)

  await h.dispatchKey({ ui: h.ui, ...press("f", { meta: true }) })
  assert.equal(h.ui.inputCursor, 5, "Alt+F 走到词尾")
  assert.ok(!h.calls.includes("acceptGhost"), "Alt+F 不该落到 Ctrl+F 的接受 ghost 上")
})

test("Ctrl+W deletes the previous word", async () => {
  const h = harness()
  h.ui.input = "hello world"
  h.ui.inputCursor = 11
  const result = await h.dispatchKey({ ui: h.ui, ...press("w", { ctrl: true }) })
  assert.equal(result.handler, "deleteWordBefore")
  assert.equal(h.ui.input, "hello ")
  assert.equal(h.ui.inputCursor, 6)
})

test("Alt+Backspace is not a second entry to the word delete", async () => {
  // 「能力不能少，入口不要多」：删前一个词只有 Ctrl+W 一个键。Alt+Backspace 曾经
  // 作为同义键一起接在 deleteWordBefore 上，砍掉了 —— 它没带来任何 Ctrl+W 做不到
  // 的事。落到裸 backspace 上删掉一个字符是刻意不管的降级。
  const h = harness()
  h.ui.input = "hello world"
  h.ui.inputCursor = 11
  const result = await h.dispatchKey({ ui: h.ui, ...press("backspace", { meta: true }) })
  assert.equal(result.handler, "backspace", "Alt+Backspace 不该再被 deleteWordBefore 接走")
  assert.equal(h.ui.input, "hello worl", "退化成删一个字符，而不是删掉整个词")
})

test("Alt+D deletes the word after the cursor", async () => {
  const h = harness()
  h.ui.input = "hello world"
  h.ui.inputCursor = 0
  const result = await h.dispatchKey({ ui: h.ui, ...press("d", { meta: true }) })
  assert.equal(result.handler, "deleteWordAfter",
    "Alt+D 不能落到 lifecycle 的 Ctrl+D 退出上")
  assert.equal(h.ui.input, " world")
  assert.equal(h.ui.inputCursor, 0)
  assert.ok(!h.calls.includes("requestExit"))
})

test("Ctrl+U kills to the line start and does nothing once it is there", async () => {
  const h = harness()
  h.ui.input = "一二\n三四"
  h.ui.inputCursor = 5
  await h.dispatchKey({ ui: h.ui, ...press("u", { ctrl: true }) })
  assert.equal(h.ui.input, "一二\n", "只清掉当前逻辑行")
  assert.equal(h.ui.inputCursor, 3)

  await h.dispatchKey({ ui: h.ui, ...press("u", { ctrl: true }) })
  assert.equal(h.ui.input, "一二\n", "已在行首时是 no-op，不会把上一行吞掉")
})

test("Ctrl+K kills to the line end, then joins the next line", async () => {
  const h = harness()
  h.ui.input = "abc\ndef"
  h.ui.inputCursor = 1
  await h.dispatchKey({ ui: h.ui, ...press("k", { ctrl: true }) })
  assert.equal(h.ui.input, "a\ndef")

  await h.dispatchKey({ ui: h.ui, ...press("k", { ctrl: true }) })
  assert.equal(h.ui.input, "adef", "行尾再按一次删掉换行符，把下一行接上来")
})

test("a selection wins over every word delete", async () => {
  // 与退格 / Delete / 插入同一条优先级：有选区先删选区。
  // 漏了这一步的话，框选一段再按 Ctrl+W 删掉的是选区左边那个词，选区还留着。
  const h = harness()
  h.ui.input = "hello world"
  h.ui.inputCursor = 11
  h.ui.inputSelection = { start: 0, end: 5 }
  await h.dispatchKey({ ui: h.ui, ...press("w", { ctrl: true }) })
  assert.equal(h.ui.input, " world", "删的是选区")
  assert.equal(h.ui.inputCursor, 0)
  assert.equal(h.ui.inputSelection, null)
})

test("the emacs keys work while the model is busy", async () => {
  // 行编辑只动输入框那一个字符串，与回合无关 —— 排队输入正需要它们
  const h = harness({ busy: true })
  h.ui.input = "hello world"
  h.ui.inputCursor = 11
  await h.dispatchKey({ ui: h.ui, ...press("w", { ctrl: true }) })
  assert.equal(h.ui.input, "hello ")
})
