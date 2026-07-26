import test from "node:test"
import assert from "node:assert/strict"
import { createKeyDispatcher } from "../src/repl/key-dispatch.mjs"
import { createOverlayKeyScopes } from "../src/repl/keys/overlay-keys.mjs"
import { createReplUiState } from "../src/repl/ui-state.mjs"

/**
 * 真实浮层作用域的行为。
 *
 * `test/repl-key-dispatch.test.mjs` 测的是分派器框架本身；这里测的是实际接进
 * REPL 的那九个作用域 —— 它们此前是 onKey 里 326 行的顺序 `if`，只有真的按下去
 * 才知道对不对。
 */

const PERMISSION_PROMPT_VALUES = ["allow_once", "allow_always", "deny", "deny_always"]
const POLICY_CHOICES = [1, 2, 3, 4]
const MODE_PICKER_CHOICES = [1, 2, 3, 4, 5]

function harness() {
  const calls = []
  const spy = (name) => (...args) => { calls.push(args.length ? `${name}(${args.join(",")})` : name) }
  const scopes = createOverlayKeyScopes({
    requestRender: () => {},
    closeInfoPanel: spy("closeInfoPanel"),
    scrollInfoPanel: spy("scrollInfoPanel"),
    resolvePermissionPrompt: spy("resolvePermission"),
    resolveQuestionPrompt: spy("resolveQuestion"),
    commitCurrentQuestionAnswer: spy("commitAnswer"),
    advanceOrSubmitQuestion: spy("advanceQuestion"),
    insertQuestionText: spy("insertText"),
    moveGraphemeCursor: (text, cursor, delta) => Math.max(0, Math.min(text.length, cursor + delta)),
    closeProviderPicker: spy("closeProvider"),
    confirmProviderPicker: spy("confirmProvider"),
    closeSessionPicker: spy("closeSession"),
    confirmSessionPicker: spy("confirmSession"),
    closeModelPicker: spy("closeModel"),
    confirmModelPicker: spy("confirmModel"),
    closePolicyPicker: spy("closePolicy"),
    confirmPolicyPicker: spy("confirmPolicy"),
    closeModePicker: spy("closeMode"),
    confirmModePicker: spy("confirmMode"),
    PERMISSION_PROMPT_VALUES,
    POLICY_CHOICES,
    MODE_PICKER_CHOICES
  })
  const { dispatchKey, describeOrder } = createKeyDispatcher({ scopes })
  return { dispatchKey, describeOrder, calls, scopes }
}

function press(name, extra = {}) {
  return { key: { name, ...extra }, str: extra.str || "" }
}

const PICKER_ITEMS = [{ id: "a", label: "甲" }, { id: "b", label: "乙" }, { id: "c", label: "丙" }]

test("every overlay scope is modal — an unhandled key never reaches the input box", async () => {
  // 枚举驱动：新增一个浮层作用域会自动被这条覆盖。这条守的是「选择器开着时
  // 敲 a 不该改到你的提示词」。
  const { scopes } = harness()
  const notModal = scopes.filter((scope) => !scope.modal).map((scope) => scope.id)
  assert.deepEqual(notModal, [], `这些浮层作用域不是模态的: ${notModal.join(", ")}`)
  assert.ok(scopes.length >= 9, `作用域数看起来不对: ${scopes.length}`)
})

test("an open info panel takes the arrow keys before anything else", async () => {
  const { dispatchKey, calls, describeOrder } = harness()
  const ui = createReplUiState()
  ui.infoPanel = { title: "t", lines: ["x"], offset: 0, maxOffset: 5, maxRows: 10 }
  ui.modelPicker = { items: PICKER_ITEMS, selected: 0, offset: 0 }  // 故意同时开着

  const result = await dispatchKey({ ui, ...press("up") })
  assert.equal(result.scope, "infoPanel", "信息浮层必须排在选择器之前")
  assert.deepEqual(calls, ["scrollInfoPanel(-1)"])
  assert.equal(ui.modelPicker.selected, 0, "选择器不该同时被移动")

  const order = describeOrder()
  assert.ok(order.indexOf("infoPanel.up") < order.indexOf("modelPicker.prev"),
    "优先级是可断言的数据")
})

test("the info panel closes on Esc, q, Enter and Ctrl+C alike", async () => {
  for (const [name, extra] of [["escape", {}], ["q", {}], ["return", {}], ["c", { ctrl: true }]]) {
    const { dispatchKey, calls } = harness()
    const ui = createReplUiState()
    ui.infoPanel = { title: "t", lines: ["x"], offset: 0, maxOffset: 0, maxRows: 10 }
    await dispatchKey({ ui, ...press(name, extra) })
    assert.deepEqual(calls, ["closeInfoPanel"], `${name} 应该关掉浮层 —— 读完就走不该只有 Esc 一条路`)
  }
})

test("a page key on the info panel moves by a screenful minus one", async () => {
  const { dispatchKey, calls } = harness()
  const ui = createReplUiState()
  ui.infoPanel = { title: "t", lines: [], offset: 0, maxOffset: 40, maxRows: 12 }
  await dispatchKey({ ui, ...press("pagedown") })
  assert.deepEqual(calls, ["scrollInfoPanel(11)"], "翻页要留一行重叠，否则读者会丢失上下文")
})

test("a permission prompt answers by number, Enter and Esc", async () => {
  const cases = [
    [{ key: {}, str: "1" }, "resolvePermission(allow_once)"],
    [{ key: {}, str: "3" }, "resolvePermission(deny)"],
    [press("escape"), "resolvePermission(deny)"],
    [press("return"), "resolvePermission(allow_once)"]
  ]
  for (const [input, expected] of cases) {
    const { dispatchKey, calls } = harness()
    const ui = createReplUiState()
    ui.pendingPermission = { tool: "write", resolve: () => {} }
    await dispatchKey({ ui, ...input })
    assert.deepEqual(calls, [expected])
  }
})

test("permission selection is clamped at both ends", async () => {
  const { dispatchKey } = harness()
  const ui = createReplUiState()
  ui.pendingPermission = { tool: "write", resolve: () => {} }
  for (let i = 0; i < 10; i++) await dispatchKey({ ui, ...press("down") })
  assert.equal(ui.permissionSelected, PERMISSION_PROMPT_VALUES.length - 1, "不该越过最后一项")
  for (let i = 0; i < 10; i++) await dispatchKey({ ui, ...press("up") })
  assert.equal(ui.permissionSelected, 0, "不该越过第一项")
})

test("a permission prompt swallows unrelated keys", async () => {
  // 权限提示开着时敲字符不该改输入框 —— 那会在用户没看清提示时污染下一条消息
  const { dispatchKey, calls } = harness()
  const ui = createReplUiState()
  ui.pendingPermission = { tool: "write", resolve: () => {} }
  const result = await dispatchKey({ ui, key: {}, str: "a" })
  assert.equal(result.swallowed, true)
  assert.deepEqual(calls, [])
})

test("pickers navigate, confirm and cancel", async () => {
  const cases = [
    ["providerPicker", "closeProvider", "confirmProvider"],
    ["sessionPicker", "closeSession", "confirmSession"],
    ["modelPicker", "closeModel", "confirmModel"]
  ]
  for (const [kind, close, confirm] of cases) {
    const { dispatchKey, calls } = harness()
    const ui = createReplUiState()
    ui[kind] = { items: PICKER_ITEMS, selected: 0, offset: 0 }

    await dispatchKey({ ui, ...press("down") })
    assert.equal(ui[kind].selected, 1, `${kind} 下移`)
    for (let i = 0; i < 5; i++) await dispatchKey({ ui, ...press("down") })
    assert.equal(ui[kind].selected, PICKER_ITEMS.length - 1, `${kind} 不该越过最后一项`)
    await dispatchKey({ ui, ...press("return") })
    assert.ok(calls.includes(confirm), `${kind} Enter 应确认`)
    await dispatchKey({ ui, ...press("escape") })
    assert.ok(calls.includes(close), `${kind} Esc 应取消`)
  }
})

test("a line-mode provider picker (a string array) is not treated as an overlay", async () => {
  // 行模式把 ui.providerPicker 设成字符串数组表示「等用户输编号」。那不是浮层，
  // 不该吞键 —— 否则无 TTY 模式下用户敲什么都没反应。
  const { dispatchKey } = harness()
  const ui = createReplUiState()
  ui.providerPicker = ["kimi-code", "aliyun"]
  const result = await dispatchKey({ ui, ...press("down") })
  assert.equal(result.handled, false, "编号输入态不该被浮层按键接管")
})

test("the mode picker cycles with Tab and reverses with Shift+Tab", async () => {
  const { dispatchKey } = harness()
  const ui = createReplUiState()
  ui.modePicker = { selected: 0 }
  await dispatchKey({ ui, ...press("tab") })
  assert.equal(ui.modePicker.selected, MODE_PICKER_CHOICES.length - 1, "Tab 向前循环（与关闭时手感一致）")
  await dispatchKey({ ui, ...press("tab", { shift: true }) })
  assert.equal(ui.modePicker.selected, 0, "Shift+Tab 反向")
})

test("the policy picker is bounded by its own choice count", async () => {
  const { dispatchKey } = harness()
  const ui = createReplUiState()
  ui.policyPicker = { selected: 0 }
  for (let i = 0; i < 10; i++) await dispatchKey({ ui, ...press("down") })
  assert.equal(ui.policyPicker.selected, POLICY_CHOICES.length - 1)
})

// --- 提问提示的两种子形态 ---

function questionUi({ options = [], customMode = false, multi = false } = {}) {
  const ui = createReplUiState()
  ui.pendingQuestion = {
    questions: [{ id: "q1", text: "选哪个？", options, multi, allowCustom: true }],
    resolve: () => {}
  }
  ui.questionCustomMode = customMode
  return ui
}

test("a question with options is in option mode; one without is free text", async () => {
  const withOptions = harness()
  const uiA = questionUi({ options: [{ label: "甲" }, { label: "乙" }] })
  const a = await withOptions.dispatchKey({ uiA, ui: uiA, ...press("down") })
  assert.equal(a.scope, "questionOptions")
  assert.equal(uiA.questionOptionSelected, 1)

  const noOptions = harness()
  const uiB = questionUi({ options: [] })
  const b = await noOptions.dispatchKey({ ui: uiB, key: {}, str: "字" })
  assert.equal(b.scope, "questionText", "没有选项的问题直接进自由文本形态")
  assert.deepEqual(noOptions.calls, ["insertText(字)"])
})

test("custom mode takes precedence over option mode", async () => {
  const { dispatchKey } = harness()
  const ui = questionUi({ options: [{ label: "甲" }], customMode: true })
  const result = await dispatchKey({ ui, key: {}, str: "x" })
  assert.equal(result.scope, "questionText")
})

test("Esc in custom mode goes back to the options rather than skipping", async () => {
  const { dispatchKey } = harness()
  const ui = questionUi({ options: [{ label: "甲" }], customMode: true })
  await dispatchKey({ ui, ...press("escape") })
  assert.equal(ui.questionCustomMode, false, "有选项可回时 Esc 是「回到选项」，不是「跳过」")
})

test("Esc with no options skips the question", async () => {
  const { dispatchKey, calls } = harness()
  const ui = questionUi({ options: [] })
  await dispatchKey({ ui, ...press("escape") })
  assert.equal(ui.questionAnswers.q1, "(skipped)")
  assert.ok(calls.includes("resolveQuestion"), "最后一个问题跳过后应提交")
})

test("Ctrl+Enter submits everything from either sub-shape", async () => {
  for (const patch of [{ options: [{ label: "甲" }] }, { options: [] }]) {
    const { dispatchKey, calls } = harness()
    const ui = questionUi(patch)
    await dispatchKey({ ui, ...press("return", { ctrl: true }) })
    assert.deepEqual(calls, ["commitAnswer", "resolveQuestion"],
      "Ctrl+Enter 在两种形态下都该直接交卷")
  }
})

test("selecting the custom row switches into free text", async () => {
  const { dispatchKey, calls } = harness()
  const ui = questionUi({ options: [{ label: "甲" }] })
  ui.questionOptionSelected = 1   // 选项之后的那一行就是「自定义…」
  await dispatchKey({ ui, ...press("return") })
  assert.equal(ui.questionCustomMode, true)
  assert.deepEqual(calls, [], "进自由文本不算作答，不该提交")
})

test("space toggles a checkbox only on multi-select questions", async () => {
  const multi = harness()
  const uiA = questionUi({ options: [{ label: "甲" }, { label: "乙" }], multi: true })
  await multi.dispatchKey({ ui: uiA, ...press("space") })
  assert.deepEqual([...uiA.questionMultiSelected.q1], [0])
  await multi.dispatchKey({ ui: uiA, ...press("space") })
  assert.deepEqual([...uiA.questionMultiSelected.q1], [], "再按一次取消勾选")

  const single = harness()
  const uiB = questionUi({ options: [{ label: "甲" }], multi: false })
  const result = await single.dispatchKey({ ui: uiB, ...press("space") })
  assert.equal(result.swallowed, true, "单选题的空格不该勾选，也不该漏到输入框")
})

test("a control character is not inserted as question text", async () => {
  const { dispatchKey, calls } = harness()
  const ui = questionUi({ options: [] })
  await dispatchKey({ ui, key: {}, str: String.fromCharCode(27) })
  assert.deepEqual(calls, [], "转义字符不是文本输入")
})
