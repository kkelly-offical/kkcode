/**
 * 浮层类按键：信息面板、权限提示、提问提示、六个选择器。
 *
 * 全部是**模态作用域** —— 打开时未命中的按键被吞掉，而不是漏到输入框去。
 * 这对应拆分前那种「整块包住、末尾一个裸 `return`」的写法。
 *
 * 选择器彼此逐字相同，只有状态字段与确认/关闭函数不同，所以用 `pickerScope`
 * 生成。`modePicker` 多一个 Tab 循环，从 `lead` 插进去；`themePicker` 多一个
 * 「选中即预览」，从 `onMove` 插进去。
 *
 * ## 打字：两种语义，取决于列表从哪来
 *
 * `PICKER_DEFS` 里的 `typing` 字段不是口味选择，是**渲染方读哪份数据**决定的：
 *
 * - `filter` —— provider / session / model：frame-builder 渲染 `ui[kind].items`，
 *   所以把 `items` 换成过滤后的那份，界面立刻就是过滤后的列表。
 * - `jump`   —— policy / mode / theme：打字「跳到最匹配的一项」，不留过滤串。
 *   policy 与 mode 是因为 frame-builder 直接读模块常量 `POLICY_CHOICES` /
 *   `MODE_PICKER_CHOICES` 渲染，过滤它们的 `items` 影响不到画面，反而会让
 *   `selected` 指向一份没人画的列表；theme 的画面读的是 `ui.themePicker.items`，
 *   但它只有三四项且是选中即预览的（见 PICKER_DEFS 上的注释）。
 *
 * 所以 `choices` 收的是 **ui**：常量型的忽略它直接返回模块常量，动态型的从
 * picker 状态里取。两种都必须与 frame-builder 画的那份是同一个来源，否则
 * 「按了几下才到底」和「看见几行」会对不上。
 */

import { on } from "../key-dispatch.mjs"
import { applyOverlayFilter, filterOverlayItems } from "../../ui/overlay-select.mjs"
import { questionTextBuffer } from "../dialog-router.mjs"

/**
 * 选择器的定义表。
 *
 * 测试遍历它生成用例 —— 手写几份的话，下一个选择器加进来时会静默漏测。
 * `createOverlayKeyScopes` 也按它组装，两边不会分叉。
 */
export const PICKER_DEFS = Object.freeze([
  Object.freeze({ kind: "providerPicker", typing: "filter" }),
  Object.freeze({ kind: "sessionPicker", typing: "filter" }),
  Object.freeze({ kind: "modelPicker", typing: "filter" }),
  Object.freeze({ kind: "policyPicker", typing: "jump" }),
  Object.freeze({ kind: "modePicker", typing: "jump" }),
  // 主题选择器是 `jump` 而不是 `filter`，两条理由：
  //   1. 项目只有 3–4 个（dark / light / auto / 文件主题），过滤一个四行的列表
  //      省不下按键，却要用户先猜「这里能打字吗」；
  //   2. 它是**选中即预览**的：每次移动选中项就把主题真的换上去。过滤会让
  //      「移动」同时意味着「列表变了」，预览到底在预览哪一项就说不清了。
  Object.freeze({ kind: "themePicker", typing: "jump" })
])

/**
 * 可打印文本：不带 ctrl/meta，且不是控制字符。
 *
 * 控制字符必须挡掉 —— Tab 的 `str` 是 `\t`、Esc 是 `\x1b`，进了过滤串就是一个
 * 看不见却匹配不上任何东西的字符，用户只会看到列表突然空了。
 */
const printableText = (ctx) => Boolean(ctx.str) && !ctx.key.ctrl && !ctx.key.meta &&
  !/[\u0000-\u001f\u007f-\u009f]/u.test(ctx.str)

/**
 * 「上下选一个、Enter 确认、Esc 取消」的选择器，外加打字过滤。
 *
 * @param {{kind: string, typing: "filter"|"jump"}} def
 * @param {object} p
 * @param {Function} [p.choices]  (ui) => 选项数组；`jump` 型必需
 * @param {Function} p.confirm
 * @param {Function} p.close
 * @param {Function} p.requestRender
 * @param {Function} p.moveGraphemeCursor  Backspace 按字素簇退，不切开 emoji
 * @param {Array}    [p.lead]     插在最前面的额外处理器
 * @param {Function} [p.onMove]   选中项**移动之后**的回调（themePicker 的即时预览）
 */
function pickerScope({ kind, typing }, { choices, confirm, close, requestRender, moveGraphemeCursor, lead = [], onMove = null }) {
  const filters = typing === "filter"
  // 候选数：过滤型的列表在 picker 状态里（过滤后会变短），跳转型的问 choices
  const count = (ui) => filters ? (ui[kind].items?.length || 0) : choices(ui).length
  // 移动之后的副作用。默认什么都不做 —— 只有 themePicker 用它做即时预览。
  const moved = () => { if (onMove) onMove() }

  const typingHandlers = filters
    ? [
      {
        id: "filterBackspace",
        when: (ctx) => ctx.key.name === "backspace" && Boolean(ctx.ui[kind]?.filter),
        run: ({ ui }) => {
          const filter = ui[kind].filter
          applyOverlayFilter(ui[kind], filter.slice(0, moveGraphemeCursor(filter, filter.length, -1)))
          requestRender()
        }
      },
      {
        id: "filterInsert",
        when: printableText,
        run: ({ ui, str }) => {
          applyOverlayFilter(ui[kind], `${ui[kind].filter || ""}${str}`)
          requestRender()
        }
      }
    ]
    : [
      {
        // 跳转型：不留过滤串，每次按键独立地跳到最匹配的一项。
        // 留一个看不见的过滤串会让 Esc 的两级退出第一下「什么都没发生」。
        id: "jumpToMatch",
        when: printableText,
        run: ({ ui, str }) => {
          const [best] = filterOverlayItems(choices(ui), str)
          if (best) ui[kind].selected = best.sourceIndex
          moved()
          requestRender()
        }
      }
    ]

  return {
    id: kind,
    modal: true,
    // 行模式下 providerPicker 会被设成字符串数组（编号输入态），那种形态没有
    // items 字段，不该走浮层按键 —— 用 Array.isArray(items) 区分。
    active: filters
      ? ((ctx) => Boolean(ctx.ui[kind]) && Array.isArray(ctx.ui[kind].items))
      : ((ctx) => Boolean(ctx.ui[kind])),
    handlers: [
      ...lead,
      {
        // 两级退出：先清过滤，再关浮层。敲了半天过滤串按 Esc 就整个关掉，
        // 等于逼用户从头再开一次。
        id: "clearFilter",
        when: (ctx) => ctx.key.name === "escape" && Boolean(ctx.ui[kind]?.filter),
        run: ({ ui }) => { applyOverlayFilter(ui[kind], ""); requestRender() }
      },
      { id: "cancel", when: on.key("escape"), run: () => { close() } },
      // 过滤到一个不剩时 Enter 不该确认 —— 那会取出 undefined 并把浮层关掉
      { id: "confirm", when: (ctx) => ctx.key.name === "return" && count(ctx.ui) > 0, run: () => confirm() },
      {
        id: "prev",
        when: on.key("up"),
        run: ({ ui }) => {
          ui[kind].selected = Math.max(0, ui[kind].selected - 1)
          moved()
          requestRender()
        }
      },
      {
        id: "next",
        when: on.key("down"),
        run: ({ ui }) => {
          // 外层的 max(0) 是给空结果准备的：count 为 0 时 min(-1, …) 会是 -1
          ui[kind].selected = Math.max(0, Math.min(count(ui) - 1, ui[kind].selected + 1))
          moved()
          requestRender()
        }
      },
      // 打字排在导航键之后：否则 j/k 之类的字符会被过滤器抢走
      ...typingHandlers
    ]
  }
}

export function createOverlayKeyScopes({
  requestRender,
  closeInfoPanel,
  scrollInfoPanel,
  resolvePermissionPrompt,
  resolveQuestionPrompt,
  commitCurrentQuestionAnswer,
  advanceOrSubmitQuestion,
  insertQuestionText,
  moveGraphemeCursor,
  closeProviderPicker,
  confirmProviderPicker,
  closeSessionPicker,
  confirmSessionPicker,
  closeModelPicker,
  confirmModelPicker,
  closePolicyPicker,
  confirmPolicyPicker,
  closeModePicker,
  confirmModePicker,
  closeThemePicker,
  confirmThemePicker,
  // 选中即预览。宿主没接的话退化成「Enter 才生效」，浮层其余部分照常可用 ——
  // 所以给一个空实现，而不是让它 undefined 崩在按键处理里。
  previewThemePicker = () => {},
  PERMISSION_PROMPT_VALUES,
  POLICY_CHOICES,
  MODE_PICKER_CHOICES
}) {
  const panelPage = (ui) => Math.max(1, (ui.infoPanel.maxRows || 14) - 1)

  return [
    // 信息浮层排在所有浮层之前：它是模态的，打开时应吃掉导航键，
    // 否则 ↑↓ 会同时滚浮层和翻输入历史。
    {
      id: "infoPanel",
      modal: true,
      active: (ctx) => Boolean(ctx.ui.infoPanel),
      handlers: [
        {
          id: "close",
          // Enter 也关：读完就走是最常见的动作，不该只有 Esc 一条路
          when: (ctx) => ["escape", "q", "return", "enter"].includes(ctx.key.name) ||
            (ctx.key.ctrl && ctx.key.name === "c"),
          run: () => { closeInfoPanel() }
        },
        { id: "up", when: on.key("up"), run: () => scrollInfoPanel(-1) },
        { id: "down", when: on.key("down"), run: () => scrollInfoPanel(1) },
        { id: "pageUp", when: on.key("pageup"), run: ({ ui }) => scrollInfoPanel(-panelPage(ui)) },
        { id: "pageDown", when: on.key("pagedown"), run: ({ ui }) => scrollInfoPanel(panelPage(ui)) },
        { id: "top", when: on.key("home"), run: () => scrollInfoPanel(-Number.MAX_SAFE_INTEGER) },
        { id: "bottom", when: on.key("end"), run: () => scrollInfoPanel(Number.MAX_SAFE_INTEGER) }
      ]
    },

    {
      id: "permission",
      modal: true,
      active: (ctx) => Boolean(ctx.ui.pendingPermission),
      handlers: [
        {
          id: "pickByNumber",
          when: (ctx) => ["1", "2", "3", "4"].includes(ctx.str),
          run: ({ str }) => resolvePermissionPrompt(PERMISSION_PROMPT_VALUES[Number(str) - 1])
        },
        { id: "deny", when: on.key("escape"), run: () => resolvePermissionPrompt("deny") },
        {
          id: "confirm",
          when: on.key("return"),
          run: ({ ui }) => resolvePermissionPrompt(PERMISSION_PROMPT_VALUES[ui.permissionSelected] || "deny")
        },
        {
          id: "prev",
          when: on.key("up"),
          run: ({ ui }) => {
            ui.permissionSelected = Math.max(0, ui.permissionSelected - 1)
            requestRender()
          }
        },
        {
          id: "next",
          when: on.key("down"),
          run: ({ ui }) => {
            ui.permissionSelected = Math.min(PERMISSION_PROMPT_VALUES.length - 1, ui.permissionSelected + 1)
            requestRender()
          }
        }
      ]
    },

    // 提问提示有两个子形态：选项列表与自由文本。自由文本形态在
    // `questionCustomMode` 或该问题压根没有选项时生效。
    {
      id: "questionText",
      modal: true,
      active: (ctx) => {
        if (!ctx.ui.pendingQuestion) return false
        const current = (ctx.ui.pendingQuestion.questions || [])[ctx.ui.questionIndex] || {}
        const options = Array.isArray(current.options) ? current.options : []
        return ctx.ui.questionCustomMode || options.length === 0
      },
      handlers: [
        {
          id: "submitAll",
          when: (ctx) => ctx.key.ctrl && ctx.key.name === "return",
          run: () => { commitCurrentQuestionAnswer(); resolveQuestionPrompt() }
        },
        {
          // 自由文本形态也要能 Tab 翻页。此前只有 questionOptions 作用域接 Tab，
          // 而 questionText 排在它前面且是模态的 —— 一页里全是文本字段（provider
          // 表单就是）时 Tab 会被吞掉，用户根本切不到下一个字段。
          id: "switchQuestion",
          when: (ctx) => ctx.key.name === "tab" && (ctx.ui.pendingQuestion?.questions || []).length > 1,
          run: (ctx) => {
            const { ui, key } = ctx
            const questions = ui.pendingQuestion.questions || []
            ui.questionAnswers[currentQuestion(ctx).id] = ui.questionCustomInput || ""
            const next = key.shift
              ? (ui.questionIndex > 0 ? ui.questionIndex - 1 : questions.length - 1)
              : (ui.questionIndex + 1) % questions.length
            enterQuestion(ui, next)
            requestRender()
          }
        },
        {
          id: "backToOptions",
          when: (ctx) => ctx.key.name === "escape" && questionOptions(ctx).length > 0,
          run: ({ ui }) => { ui.questionCustomMode = false; requestRender() }
        },
        {
          id: "skip",
          when: (ctx) => ctx.key.name === "escape" && questionOptions(ctx).length === 0,
          run: (ctx) => {
            const { ui } = ctx
            const questions = ui.pendingQuestion.questions || []
            ui.questionAnswers[currentQuestion(ctx).id] = "(skipped)"
            if (ui.questionIndex < questions.length - 1) {
              enterQuestion(ui, ui.questionIndex + 1)
            } else {
              resolveQuestionPrompt()
            }
            requestRender()
          }
        },
        {
          id: "commit",
          when: on.key("return"),
          run: (ctx) => {
            const { ui } = ctx
            const questions = ui.pendingQuestion.questions || []
            ui.questionAnswers[currentQuestion(ctx).id] = ui.questionCustomInput || ""
            ui.questionCustomMode = false
            if (ui.questionIndex < questions.length - 1) {
              enterQuestion(ui, ui.questionIndex + 1)
            } else {
              resolveQuestionPrompt()
            }
            requestRender()
          }
        },
        {
          id: "backspace",
          when: on.key("backspace"),
          run: ({ ui }) => {
            if (ui.questionCustomCursor > 0) {
              const previous = moveGraphemeCursor(ui.questionCustomInput, ui.questionCustomCursor, -1)
              const before = ui.questionCustomInput.slice(0, previous)
              const after = ui.questionCustomInput.slice(ui.questionCustomCursor)
              ui.questionCustomInput = before + after
              ui.questionCustomCursor = previous
            }
            requestRender()
          }
        },
        {
          id: "left",
          when: on.key("left"),
          run: ({ ui }) => {
            ui.questionCustomCursor = moveGraphemeCursor(ui.questionCustomInput, ui.questionCustomCursor, -1)
            requestRender()
          }
        },
        {
          id: "right",
          when: on.key("right"),
          run: ({ ui }) => {
            ui.questionCustomCursor = moveGraphemeCursor(ui.questionCustomInput, ui.questionCustomCursor, 1)
            requestRender()
          }
        },
        {
          id: "insert",
          // 控制字符不算输入 —— 它们会把光标算错，也可能带终端序列
          when: (ctx) => Boolean(ctx.str) && !ctx.key.ctrl && !ctx.key.meta &&
            !/[\u0000-\u001f\u007f-\u009f]/u.test(ctx.str),
          run: ({ str }) => { insertQuestionText(str); requestRender() }
        }
      ]
    },

    {
      id: "questionOptions",
      modal: true,
      active: (ctx) => Boolean(ctx.ui.pendingQuestion),
      handlers: [
        {
          id: "submitAll",
          when: (ctx) => ctx.key.ctrl && ctx.key.name === "return",
          run: () => { commitCurrentQuestionAnswer(); resolveQuestionPrompt() }
        },
        {
          id: "skip",
          when: on.key("escape"),
          run: (ctx) => {
            const { ui } = ctx
            const questions = ui.pendingQuestion.questions || []
            ui.questionAnswers[currentQuestion(ctx).id] = "(skipped)"
            if (ui.questionIndex < questions.length - 1) {
              enterQuestion(ui, ui.questionIndex + 1)
            } else {
              resolveQuestionPrompt()
            }
            requestRender()
          }
        },
        {
          id: "prev",
          when: on.key("up"),
          run: ({ ui }) => {
            ui.questionOptionSelected = Math.max(0, ui.questionOptionSelected - 1)
            requestRender()
          }
        },
        {
          id: "next",
          when: on.key("down"),
          run: (ctx) => {
            const { ui } = ctx
            ui.questionOptionSelected = Math.min(maxOptionIndex(ctx), ui.questionOptionSelected + 1)
            requestRender()
          }
        },
        {
          id: "switchQuestion",
          when: on.key("tab"),
          run: ({ ui, key }) => {
            const questions = ui.pendingQuestion.questions || []
            const next = key.shift
              ? (ui.questionIndex > 0 ? ui.questionIndex - 1 : questions.length - 1)
              : (ui.questionIndex + 1) % questions.length
            enterQuestion(ui, next)
            requestRender()
          }
        },
        {
          id: "toggleMulti",
          when: (ctx) => ctx.key.name === "space" && Boolean(currentQuestion(ctx).multi),
          run: (ctx) => {
            const { ui } = ctx
            const current = currentQuestion(ctx)
            if (ui.questionOptionSelected >= questionOptions(ctx).length) return
            if (!ui.questionMultiSelected[current.id]) ui.questionMultiSelected[current.id] = new Set()
            const set = ui.questionMultiSelected[current.id]
            if (set.has(ui.questionOptionSelected)) set.delete(ui.questionOptionSelected)
            else set.add(ui.questionOptionSelected)
            requestRender()
          }
        },
        {
          id: "choose",
          when: on.key("return"),
          run: (ctx) => {
            const { ui } = ctx
            const options = questionOptions(ctx)
            // 选中的是「自定义…」那一项 → 进自由文本形态
            if (ui.questionOptionSelected === options.length && currentQuestion(ctx).allowCustom !== false) {
              ui.questionCustomMode = true
              ui.questionCustomInput = ""
              ui.questionCustomCursor = 0
              requestRender()
              return
            }
            advanceOrSubmitQuestion()
          }
        }
      ]
    },

    // 选择器按 PICKER_DEFS 组装。少一条接线会当场抛错，而不是悄悄
    // 少掉一个作用域 —— 少掉的话那个浮层的按键会漏到输入框里去。
    ...PICKER_DEFS.map((def) => {
      const wiring = {
        providerPicker: { confirm: () => { void confirmProviderPicker() }, close: closeProviderPicker },
        sessionPicker: { confirm: () => { void confirmSessionPicker() }, close: closeSessionPicker },
        modelPicker: { confirm: confirmModelPicker, close: closeModelPicker },
        policyPicker: { confirm: confirmPolicyPicker, close: closePolicyPicker, choices: () => POLICY_CHOICES },
        themePicker: {
          confirm: confirmThemePicker,
          close: closeThemePicker,
          // 主题列表是运行期算出来的（dark/light/auto + 可选的文件主题），
          // 没有模块常量可读 —— 与 frame-builder 画的是同一份 ui.themePicker.items。
          choices: (ui) => ui.themePicker?.items || [],
          onMove: previewThemePicker
        },
        modePicker: {
          confirm: confirmModePicker,
          close: closeModePicker,
          choices: () => MODE_PICKER_CHOICES,
          // 模式选择器比其它四个多一条：面板打开时 Shift+Tab 继续循环，
          // 手感与面板关闭时按 Shift+Tab 一致。
          lead: [{
            id: "cycle",
            when: on.key("tab"),
            run: ({ ui, key }) => {
              const delta = key.shift ? 1 : -1
              const count = MODE_PICKER_CHOICES.length
              ui.modePicker.selected = (ui.modePicker.selected + delta + count) % count
              requestRender()
            }
          }]
        }
      }[def.kind]
      if (!wiring) throw new Error(`选择器 ${def.kind} 没有接线`)
      return pickerScope(def, { ...wiring, requestRender, moveGraphemeCursor })
    })
  ]
}

function currentQuestion(ctx) {
  return (ctx.ui.pendingQuestion?.questions || [])[ctx.ui.questionIndex] || {}
}

/**
 * 切到第 index 题：编辑缓冲区跟着换成**那一题**的内容。
 *
 * 见 dialog-router 的 `questionTextBuffer` —— 缓冲区不跟着问题走的话，一页多个
 * 文本字段会互相串味，切回去还拿不回已答的内容。
 */
function enterQuestion(ui, index) {
  ui.questionIndex = index
  ui.questionOptionSelected = 0
  ui.questionCustomMode = false
  const question = (ui.pendingQuestion?.questions || [])[index]
  ui.questionCustomInput = questionTextBuffer(question, ui.questionAnswers)
  ui.questionCustomCursor = ui.questionCustomInput.length
}

function questionOptions(ctx) {
  const options = currentQuestion(ctx).options
  return Array.isArray(options) ? options : []
}

function maxOptionIndex(ctx) {
  const current = currentQuestion(ctx)
  return questionOptions(ctx).length + (current.allowCustom !== false ? 1 : 0) - 1
}
