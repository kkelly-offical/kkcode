import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createKeyDispatcher } from "../src/repl/key-dispatch.mjs"
import { createOverlayKeyScopes, PICKER_DEFS } from "../src/repl/keys/overlay-keys.mjs"
import { createReplUiState } from "../src/repl/ui-state.mjs"
import { createPickerFilterState } from "../src/ui/overlay-select.mjs"

/**
 * 真实浮层作用域的行为。
 *
 * `test/repl-key-dispatch.test.mjs` 测的是分派器框架本身；这里测的是实际接进
 * REPL 的那九个作用域 —— 它们此前是 onKey 里 326 行的顺序 `if`，只有真的按下去
 * 才知道对不对。
 */

const PERMISSION_PROMPT_VALUES = ["allow_once", "allow_always", "deny", "deny_always"]
// 带 label 的形状与真实常量一致（permission-flow.mjs / mode-flow.mjs）——
// 这两个选择器的列表由 frame-builder 直接读常量渲染，打字只能跳选中项。
const POLICY_CHOICES = [
  { label: "Readonly" }, { label: "Manual" }, { label: "Accept Edits" }, { label: "YOLO" }
]
const MODE_PICKER_CHOICES = [
  { label: "🤖 Agent" }, { label: "📝 Plan" }, { label: "💬 Chat" },
  { label: "🔍 Review" }, { label: "🛠 Build" }
]
// 主题选择器的候选是运行期算出来的，所以它躺在 picker 状态里而不是模块常量里
// （形状与 repl/theme-switch.mjs 的 list() 一致）。
const THEME_ITEMS = [
  { id: "dark", label: "dark" }, { id: "light", label: "light" },
  { id: "auto", label: "auto" }, { id: "mine.yaml", label: "mine.yaml" }
]

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
    closeThinkingPicker: spy("closeThinking"),
    confirmThinkingPicker: spy("confirmThinking"),
    closePolicyPicker: spy("closePolicy"),
    confirmPolicyPicker: spy("confirmPolicy"),
    closeModePicker: spy("closeMode"),
    confirmModePicker: spy("confirmMode"),
    closeThemePicker: spy("closeTheme"),
    confirmThemePicker: spy("confirmTheme"),
    previewThemePicker: spy("previewTheme"),
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

// --- 打字过滤 ---
//
// 全部由 `PICKER_DEFS` 驱动生成。手写五份的话，第六个选择器加进来时会静默
// 漏测 —— 这个仓库栽过这一条。

// 顺序刻意排成「过滤后会被完全打乱」：s4 前缀 → s3 子串 → s1 子序列，s2 被滤掉。
// 过滤前后下标恰好一样的话，「选中跟随」的用例在实现坏掉时也会绿。
const FILTER_ITEMS = [
  { id: "s1", label: "align user token help" },  // 子序列命中
  { id: "s2", label: "rewrite the parser" },     // 不命中
  { id: "s3", label: "refactor auth module" },   // 子串命中
  { id: "s4", label: "authorize the deploy" }    // 前缀命中
]
// 思考档位的形状与真实构造一致（overlay-controller 的 openThinkingPicker）
const THINKING_ITEMS = [
  { id: "off", label: "off" }, { id: "low", label: "low" }, { id: "medium", label: "medium" },
  { id: "high", label: "high", current: true }, { id: "max", label: "max" }
]
const CHOICES = {
  policyPicker: POLICY_CHOICES,
  modePicker: MODE_PICKER_CHOICES,
  themePicker: THEME_ITEMS,
  thinkingPicker: THINKING_ITEMS
}
/** 候选放在 picker 状态里而不是模块常量里的那些（列表是运行期算的）。 */
const STATE_CARRIED = new Set(["themePicker", "thinkingPicker"])
const FILTER_DEFS = PICKER_DEFS.filter((def) => def.typing === "filter")
const JUMP_DEFS = PICKER_DEFS.filter((def) => def.typing === "jump")

const typeChar = (str) => ({ key: {}, str })

/** providerPicker -> closeProvider / confirmProvider（harness 里的 spy 名） */
function spyOf(verb, kind) {
  const stem = kind.replace(/Picker$/, "")
  return `${verb}${stem[0].toUpperCase()}${stem.slice(1)}`
}

function openPicker(ui, def) {
  if (def.typing === "filter") {
    ui[def.kind] = createPickerFilterState(FILTER_ITEMS, 0)
  } else {
    ui[def.kind] = STATE_CARRIED.has(def.kind)
      ? { selected: 0, items: CHOICES[def.kind] }
      : { selected: 0 }
  }
  return ui[def.kind]
}

/**
 * 只出现在某一项、且那项不是第一项的字符。
 * 用它验证「打字真的把选中项移到了匹配的那项」，而不是碰巧停在原地。
 */
function uniqueProbe(choices) {
  for (const ch of "abcdefghijklmnopqrstuvwxyz") {
    const hits = choices
      .map((choice, index) => ({ index, has: String(choice.label).toLowerCase().includes(ch) }))
      .filter((entry) => entry.has)
    if (hits.length === 1 && hits[0].index > 0) return { ch, index: hits[0].index }
  }
  throw new Error("测试数据里找不到唯一命中字符 —— 用例没法验证跳转")
}

async function typeAll(dispatchKey, ui, text) {
  for (const ch of text) await dispatchKey({ ui, ...typeChar(ch) })
}

/** 从 `name(` 开始按括号配平取出整个实参块。锚点失效时返回 null，而不是半截。 */
function callArguments(source, name) {
  const start = source.indexOf(`${name}(`)
  if (start === -1) return null
  let depth = 0
  for (let i = start + name.length; i < source.length; i++) {
    if (source[i] === "(") depth += 1
    else if (source[i] === ")") {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return null
}

test("repl.mjs wires close/confirm for every picker in the table", () => {
  // 组装根少传一个 `close<X>Picker`，构造时不会报错 —— 那个函数是 undefined，
  // 直到用户真的打开那个浮层按下 Esc 才炸。单测这边照绿：harness 自己传全了。
  //
  // 所以这条按 PICKER_DEFS 扫组装根。手写一份清单的话，下一个选择器加进来时
  // 它会静默漏掉那一个 —— 这个仓库栽过同一条。
  const replSource = readFileSync(fileURLToPath(new URL("../src/repl.mjs", import.meta.url)), "utf8")
  const block = callArguments(replSource, "createOverlayKeyScopes")
  assert.ok(block, "找不到 createOverlayKeyScopes 的调用 —— 锚点没了，这条断言得跟着改")
  // 防空转：锚点还在但取到的是空壳时，下面的 includes 会全部为假而不是全部为真，
  // 不过取到「一小段」仍可能让断言变得没意义，所以先钉一个已知一定在里面的参数。
  assert.ok(block.includes("closeModePicker"), `取到的实参块不像是那个调用: ${block.slice(0, 120)}`)

  const missing = []
  for (const def of PICKER_DEFS) {
    const stem = `${def.kind[0].toUpperCase()}${def.kind.slice(1)}`
    for (const verb of ["close", "confirm"]) {
      if (!new RegExp(`(^|[^\\w])${verb}${stem}\\b`).test(block)) missing.push(`${verb}${stem}`)
    }
  }
  assert.deepEqual(missing, [],
    "这些接线没传进 createOverlayKeyScopes —— 对应浮层的 Esc/Enter 会调到 undefined:\n  " +
    missing.join("\n  "))
})

test("the definition table covers exactly the picker scopes that exist", () => {
  // 两边分叉的话，新选择器要么漏掉过滤、要么漏掉全部用例
  const { scopes } = harness()
  const inDispatcher = scopes.map((scope) => scope.id).filter((id) => id.endsWith("Picker"))
  assert.deepEqual(inDispatcher, PICKER_DEFS.map((def) => def.kind))
})

test("typing filters the list pickers and jumps the selection on the constant-list ones", async () => {
  for (const def of PICKER_DEFS) {
    const { dispatchKey } = harness()
    const ui = createReplUiState()
    const picker = openPicker(ui, def)

    if (def.typing === "filter") {
      await typeAll(dispatchKey, ui, "auth")
      assert.equal(picker.filter, "auth", `${def.kind}: 可打印字符应追加到 filter`)
      assert.deepEqual(picker.items.map((item) => item.id), ["s4", "s3", "s1"],
        `${def.kind}: 渲染方读的就是 items，它必须是过滤后的那份（且按档位排好）`)
      assert.equal(picker.items[0].label, "[auth]orize the deploy",
        `${def.kind}: 命中区间要标出来，无色终端下也看得见`)
    } else {
      // frame-builder 画的是模块常量，过滤它的 items 影响不到画面 ——
      // 所以这两个的打字是「跳到最匹配的一项」
      const probe = uniqueProbe(CHOICES[def.kind])
      const result = await dispatchKey({ ui, ...typeChar(probe.ch) })
      assert.equal(result.handler, "jumpToMatch", `${def.kind}: 打字应跳转`)
      assert.equal(picker.selected, probe.index, `${def.kind}: 应停在唯一命中的那项`)
    }
  }
})

test("moving the theme selection previews it immediately; other pickers have no such side effect", async () => {
  // 颜色是唯一一种「描述不出来、只能看」的设置。要求先 Enter 再判断好不好看，
  // 等于每换一次都得来回开关浮层。所以上下键就把主题真的换上去（不落盘）。
  const themeDef = PICKER_DEFS.find((def) => def.kind === "themePicker")
  const { dispatchKey, calls } = harness()
  const ui = createReplUiState()
  const picker = openPicker(ui, themeDef)

  await dispatchKey({ ui, ...press("down") })
  assert.deepEqual(calls, ["previewTheme"], "下移之后要预览")
  await dispatchKey({ ui, ...press("up") })
  assert.deepEqual(calls, ["previewTheme", "previewTheme"], "上移同样")

  // 打字跳转也是「移动选中项」，同样该预览
  await dispatchKey({ ui, ...typeChar("g") })
  assert.equal(picker.selected, 1, "g 只在 light 里有")
  assert.equal(calls.length, 3, "跳转之后漏预览的话，打字选中的那项看不到效果")

  const other = harness()
  const otherUi = createReplUiState()
  otherUi.modePicker = { selected: 0 }
  await other.dispatchKey({ ui: otherUi, ...press("down") })
  assert.deepEqual(other.calls, [], "别的选择器移动时不该有任何副作用")
})

test("the theme picker counts the rows it is actually showing", async () => {
  // 它的候选在 picker 状态里（列表是运行期算的）。若 count 去读某个模块常量，
  // 下箭头会停在错误的位置 —— 多按几下停不下来，或者提前到底。
  const { dispatchKey } = harness()
  const ui = createReplUiState()
  const picker = openPicker(ui, PICKER_DEFS.find((def) => def.kind === "themePicker"))
  for (let i = 0; i < 10; i++) await dispatchKey({ ui, ...press("down") })
  assert.equal(picker.selected, THEME_ITEMS.length - 1)
})

test("Backspace takes one character back off the filter", async () => {
  for (const def of FILTER_DEFS) {
    const { dispatchKey } = harness()
    const ui = createReplUiState()
    const picker = openPicker(ui, def)
    await typeAll(dispatchKey, ui, "auth")

    const result = await dispatchKey({ ui, ...press("backspace") })
    assert.equal(result.handler, "filterBackspace", `${def.kind}: Backspace 应删过滤串`)
    assert.equal(picker.filter, "aut", `${def.kind}: 一次删一个字符`)
    assert.equal(picker.items.length, 3, `${def.kind}: 列表要跟着重算`)
  }
})

test("the selection follows the row it was standing on", async () => {
  for (const def of FILTER_DEFS) {
    const { dispatchKey } = harness()
    const ui = createReplUiState()
    const picker = openPicker(ui, def)

    assert.equal(picker.items[picker.selected].id, "s1", "先停在会排到末尾的那一项上")
    await typeAll(dispatchKey, ui, "auth")            // s1 仍在结果里，但排到了第 3 行
    assert.equal(picker.selected, 2)
    assert.equal(picker.items[picker.selected].id, "s1",
      `${def.kind}: 过滤后把 selected 留在原位就会选中另一个东西`)
  }
})

test("the selection drops to the top when its row is filtered away", async () => {
  for (const def of FILTER_DEFS) {
    const { dispatchKey } = harness()
    const ui = createReplUiState()
    const picker = openPicker(ui, def)

    await dispatchKey({ ui, ...press("down") })
    assert.equal(picker.items[picker.selected].id, "s2", "先停在会被滤掉的那一项上")
    await typeAll(dispatchKey, ui, "auth")
    assert.equal(picker.selected, 0, `${def.kind}: 选中项不在了就归零`)
    assert.equal(picker.items[0].id, "s4")
  }
})

test("Esc clears the filter first and only then closes the overlay", async () => {
  for (const def of FILTER_DEFS) {
    const { dispatchKey, calls } = harness()
    const ui = createReplUiState()
    const picker = openPicker(ui, def)
    await typeAll(dispatchKey, ui, "auth")

    const first = await dispatchKey({ ui, ...press("escape") })
    assert.equal(first.handler, "clearFilter", `${def.kind}: 第一下 Esc 清过滤`)
    assert.equal(picker.filter, "")
    assert.equal(picker.items.length, FILTER_ITEMS.length, "列表要复原")
    assert.deepEqual(calls, [], `${def.kind}: 敲了半天过滤串按 Esc 就整个关掉太粗暴`)

    const second = await dispatchKey({ ui, ...press("escape") })
    assert.equal(second.handler, "cancel")
    assert.deepEqual(calls, [spyOf("close", def.kind)], `${def.kind}: 第二下才关`)
  }
})

test("Esc closes right away when there is no filter to clear", async () => {
  for (const def of PICKER_DEFS) {
    const { dispatchKey, calls } = harness()
    const ui = createReplUiState()
    openPicker(ui, def)
    const result = await dispatchKey({ ui, ...press("escape") })
    assert.equal(result.handler, "cancel", `${def.kind}: 没有过滤串时 Esc 直接关`)
    assert.deepEqual(calls, [spyOf("close", def.kind)])
  }
})

test("a digit goes into the filter, whether or not the filter is empty", async () => {
  // 五个选择器都没有「按数字直选」：frame-builder 只给权限浮层传了 numbered: true
  // （overlay-keys 里 permission.pickByNumber 是唯一的数字直选，本次不动它）。
  // 行前没有编号可看的话，数字直选是不可见的功能，所以数字一律进过滤串。
  // 将来若给选择器加了编号行，规则应当是「filter 为空时数字直选」。
  for (const def of FILTER_DEFS) {
    const { dispatchKey } = harness()
    const ui = createReplUiState()
    const picker = openPicker(ui, def)

    const empty = await dispatchKey({ ui, ...typeChar("3") })
    assert.equal(empty.handler, "filterInsert", `${def.kind}: filter 为空时数字仍进过滤串`)
    assert.equal(picker.filter, "3")

    await dispatchKey({ ui, ...press("escape") })
    await typeAll(dispatchKey, ui, "auth")
    await dispatchKey({ ui, ...typeChar("3") })
    assert.equal(picker.filter, "auth3", `${def.kind}: filter 非空时数字照样追加`)
  }
})

test("Enter confirms nothing while the filter matches nothing", async () => {
  for (const def of FILTER_DEFS) {
    const { dispatchKey, calls } = harness()
    const ui = createReplUiState()
    const picker = openPicker(ui, def)
    await typeAll(dispatchKey, ui, "zzz")
    assert.deepEqual(picker.items, [], "先确认真的一个都没剩")

    const result = await dispatchKey({ ui, ...press("return") })
    assert.equal(result.swallowed, true, `${def.kind}: Enter 应被吞掉`)
    assert.deepEqual(calls, [], `${def.kind}: 确认会取出 undefined 并把浮层关掉`)

    await dispatchKey({ ui, ...press("down") })
    assert.equal(picker.selected, 0, `${def.kind}: 空结果里下箭头不该把下标推到 -1`)
  }
})

test("the typing handler is declared after the navigation keys", async () => {
  // 行为断言挡不住这条：↑↓/Enter/Esc 的 str 都是控制字符，本来就进不了过滤器，
  // 所以把打字处理器挪到最前面**行为上仍然是绿的**，直到某天有人放宽了控制字符
  // 判定。优先级在这个仓库是**可断言的数据**，就按数据断言。
  const { describeOrder } = harness()
  const order = describeOrder()
  for (const def of PICKER_DEFS) {
    const typing = def.typing === "filter" ? "filterInsert" : "jumpToMatch"
    const at = (id) => order.indexOf(`${def.kind}.${id}`)
    assert.notEqual(at(typing), -1, `${def.kind}: 找不到打字处理器 ${typing}`)
    for (const nav of ["clearFilter", "cancel", "confirm", "prev", "next"]) {
      assert.notEqual(at(nav), -1, `${def.kind}: 找不到 ${nav} —— 锚点没了，这条断言得跟着改`)
      assert.ok(at(nav) < at(typing), `${def.kind}: ${nav} 必须排在打字之前`)
    }
  }
})

test("the typing handler never swallows navigation, Enter or Esc", async () => {
  // 作用域内首个 when 命中即停：过滤处理器排到导航键前面的话，j/k/Enter 都会
  // 被它吃掉，而模态作用域又不会让这些键漏出去 —— 表现为浮层彻底按不动。
  for (const def of PICKER_DEFS) {
    const { dispatchKey } = harness()
    const ui = createReplUiState()
    openPicker(ui, def)
    if (def.typing === "filter") await typeAll(dispatchKey, ui, "auth")

    const expected = [
      ["down", "next"], ["up", "prev"], ["return", "confirm"],
      ["escape", def.typing === "filter" ? "clearFilter" : "cancel"]
    ]
    for (const [key, handler] of expected) {
      const result = await dispatchKey({ ui, ...press(key) })
      assert.equal(result.handler, handler, `${def.kind}: ${key} 该归 ${handler}`)
    }
  }
})

test("Tab still cycles the mode picker instead of landing in a filter", async () => {
  const { dispatchKey } = harness()
  const ui = createReplUiState()
  ui.modePicker = { selected: 0 }
  const result = await dispatchKey({ ui, ...press("tab", { str: "\t" }) })
  assert.equal(result.handler, "cycle", "Tab 的 str 是 \\t —— 控制字符不该被当成打字")
})

test("a control character never reaches the filter", async () => {
  for (const def of FILTER_DEFS) {
    const { dispatchKey } = harness()
    const ui = createReplUiState()
    const picker = openPicker(ui, def)
    await dispatchKey({ ui, key: {}, str: "\t" })
    assert.equal(picker.filter, "",
      `${def.kind}: 看不见却匹配不上任何东西的字符会让列表莫名其妙变空`)
    assert.equal(picker.items.length, FILTER_ITEMS.length)
  }
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

// --- 提问选项的打字过滤与滚动（0.8.0） ---

const MANY_OPTIONS = [
  { label: "gpt-5.5" }, { label: "gpt-5.4-mini" }, { label: "claude-sonnet-4-6" },
  { label: "claude-opus-4-7" }, { label: "deepseek-v4-pro" }, { label: "kimi-k2.6" },
  { label: "qwen3.5-plus" }, { label: "glm-5.1" }, { label: "grok-4.3" }, { label: "moonshot-v1-128k" }
]

test("typing filters question options and Enter commits the option the user sees", async () => {
  const { dispatchKey } = harness()
  const ui = questionUi({ options: MANY_OPTIONS })
  for (const ch of "kimi") await dispatchKey({ ui, key: {}, str: ch })
  assert.equal(ui.questionFilter, "kimi")
  // 过滤后显示位置 0 是 kimi-k2.6（原下标 5）。提交换算在 dialog-router 侧钉。
  assert.equal(ui.questionOptionSelected, 0)
  const result = await dispatchKey({ ui, ...press("return") })
  assert.equal(result.scope, "questionOptions")
})

test("multi-select checkmarks are pinned to source options across filtering", async () => {
  const { dispatchKey } = harness()
  const ui = questionUi({ options: MANY_OPTIONS, multi: true })
  // 无过滤勾选第 0 项（gpt-5.5）
  await dispatchKey({ ui, ...press("space") })
  assert.deepEqual([...ui.questionMultiSelected.q1], [0])
  // 过滤到 kimi，再勾选显示位置 0 —— 应该勾中原下标 5，而不是把 0 又切掉
  for (const ch of "kimi") await dispatchKey({ ui, key: {}, str: ch })
  await dispatchKey({ ui, ...press("space") })
  assert.deepEqual([...ui.questionMultiSelected.q1].sort(), [0, 5],
    "过滤态下的勾选必须钉在原选项上，否则清掉过滤串后 ☑ 整体错位")
  // 清掉过滤串，两个勾还在原来的选项上
  await dispatchKey({ ui, ...press("escape") })
  assert.equal(ui.questionFilter, "")
  assert.deepEqual([...ui.questionMultiSelected.q1].sort(), [0, 5])
})

test("Esc clears the question filter first and only skips on the second press", async () => {
  const { dispatchKey, calls } = harness()
  const ui = questionUi({ options: MANY_OPTIONS })
  await dispatchKey({ ui, key: {}, str: "g" })
  assert.equal(ui.questionFilter, "g")
  await dispatchKey({ ui, ...press("escape") })
  assert.equal(ui.questionFilter, "", "第一下 Esc 只清过滤")
  assert.equal(ui.questionAnswers.q1, undefined, "不该跳过")
  await dispatchKey({ ui, ...press("escape") })
  assert.equal(ui.questionAnswers.q1, "(skipped)", "第二下才是跳过")
  assert.ok(calls.includes("resolveQuestion"))
})

test("selection follows the highlighted option through filter changes", async () => {
  const { dispatchKey } = harness()
  const ui = questionUi({ options: MANY_OPTIONS })
  // 高亮移到 claude-sonnet-4-6（下标 2）
  await dispatchKey({ ui, ...press("down") })
  await dispatchKey({ ui, ...press("down") })
  assert.equal(ui.questionOptionSelected, 2)
  // 过滤到 claude：son 排在 opus 前（原顺序），选中项跟随到新位置 0
  for (const ch of "claude") await dispatchKey({ ui, key: {}, str: ch })
  assert.equal(ui.questionOptionSelected, 0, "选中项按 sourceIndex 找回，不是停在旧位置")
  // Backspace 清一个字符不丢跟随
  await dispatchKey({ ui, ...press("backspace") })
  assert.equal(ui.questionFilter, "claud")
  assert.equal(ui.questionOptionSelected, 0)
})

test("filtered-to-nothing keeps Enter from committing but Custom stays reachable", async () => {
  const { dispatchKey, calls } = harness()
  const ui = questionUi({ options: MANY_OPTIONS })
  for (const ch of "zzz") await dispatchKey({ ui, key: {}, str: ch })
  // 过滤空了：可见列表 0 项 + Custom 伪项。选中位置钉在 Custom（0 == visible.length）。
  assert.equal(ui.questionOptionSelected, 0)
  await dispatchKey({ ui, ...press("return") })
  assert.equal(ui.questionCustomMode, true, "零命中时 Enter 落在 Custom 上 → 进自由文本")
  assert.equal(ui.questionFilter, "", "进自由文本时过滤串清掉")
  assert.deepEqual(calls, [], "没有任何提交发生")
})

test("switching questions resets the filter so the next list is not silently emptied", async () => {
  const { dispatchKey } = harness()
  const ui = createReplUiState()
  ui.pendingQuestion = {
    questions: [
      { id: "q1", text: "A", options: MANY_OPTIONS, allowCustom: true },
      { id: "q2", text: "B", options: [{ label: "东" }, { label: "西" }], allowCustom: true }
    ],
    resolve: () => {}
  }
  for (const ch of "gpt") await dispatchKey({ ui, key: {}, str: ch })
  assert.equal(ui.questionFilter, "gpt")
  await dispatchKey({ ui, ...press("tab") })
  assert.equal(ui.questionIndex, 1)
  assert.equal(ui.questionFilter, "", "旧过滤串带到下一题会把「东/西」滤成空列表")
  assert.equal(ui.questionOptionOffset, 0)
})

test("single-select space is still swallowed, not fed into the filter", async () => {
  const { dispatchKey } = harness()
  const ui = questionUi({ options: MANY_OPTIONS, multi: false })
  const result = await dispatchKey({ ui, key: { name: "space" }, str: " " })
  assert.equal(result.swallowed, true)
  assert.equal(ui.questionFilter, "", "空格不进过滤串 —— 单选题的空格历来不做事")
})
