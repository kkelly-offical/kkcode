/**
 * 浮层类按键：信息面板、权限提示、提问提示、五个选择器。
 *
 * 全部是**模态作用域** —— 打开时未命中的按键被吞掉，而不是漏到输入框去。
 * 这对应拆分前那种「整块包住、末尾一个裸 `return`」的写法。
 *
 * 五个选择器里有四个逐字相同，只有状态字段与确认/关闭函数不同，所以用
 * `pickerScope` 生成。`modePicker` 多一个 Tab 循环，单独写。
 */

import { on } from "../key-dispatch.mjs"

/**
 * 「上下选一个、Enter 确认、Esc 取消」的选择器。
 *
 * @param {string} kind        ui 上的字段名
 * @param {object} p
 * @param {Function} p.count   (ui) => 选项总数
 * @param {Function} p.confirm
 * @param {Function} p.close
 * @param {Function} p.requestRender
 * @param {Function} [p.active] 覆盖默认的激活判定
 */
function pickerScope(kind, { count, confirm, close, requestRender, active }) {
  return {
    id: kind,
    modal: true,
    // 行模式下 providerPicker 会被设成字符串数组（编号输入态），那种形态没有
    // items 字段，不该走浮层按键 —— 用 Array.isArray(items) 区分。
    active: active || ((ctx) => Boolean(ctx.ui[kind]) && Array.isArray(ctx.ui[kind].items)),
    handlers: [
      { id: "cancel", when: on.key("escape"), run: () => { close() } },
      { id: "confirm", when: on.key("return"), run: () => confirm() },
      {
        id: "prev",
        when: on.key("up"),
        run: ({ ui }) => {
          ui[kind].selected = Math.max(0, ui[kind].selected - 1)
          requestRender()
        }
      },
      {
        id: "next",
        when: on.key("down"),
        run: ({ ui }) => {
          ui[kind].selected = Math.min(count(ui) - 1, ui[kind].selected + 1)
          requestRender()
        }
      }
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
              ui.questionIndex += 1
              ui.questionCustomInput = ""
              ui.questionCustomCursor = 0
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
            ui.questionCustomInput = ""
            ui.questionCustomCursor = 0
            if (ui.questionIndex < questions.length - 1) {
              ui.questionIndex += 1
              ui.questionOptionSelected = 0
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
              ui.questionIndex += 1
              ui.questionOptionSelected = 0
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
            if (key.shift) {
              ui.questionIndex = ui.questionIndex > 0 ? ui.questionIndex - 1 : questions.length - 1
            } else {
              ui.questionIndex = (ui.questionIndex + 1) % questions.length
            }
            ui.questionOptionSelected = 0
            ui.questionCustomMode = false
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

    pickerScope("providerPicker", {
      count: (ui) => ui.providerPicker.items.length,
      confirm: () => { void confirmProviderPicker() },
      close: closeProviderPicker,
      requestRender
    }),
    pickerScope("sessionPicker", {
      count: (ui) => ui.sessionPicker.items.length,
      confirm: () => { void confirmSessionPicker() },
      close: closeSessionPicker,
      requestRender
    }),
    pickerScope("modelPicker", {
      count: (ui) => ui.modelPicker.items.length,
      confirm: confirmModelPicker,
      close: closeModelPicker,
      requestRender
    }),
    pickerScope("policyPicker", {
      active: (ctx) => Boolean(ctx.ui.policyPicker),
      count: () => POLICY_CHOICES.length,
      confirm: confirmPolicyPicker,
      close: closePolicyPicker,
      requestRender
    }),
    (() => {
      const base = pickerScope("modePicker", {
        active: (ctx) => Boolean(ctx.ui.modePicker),
        count: () => MODE_PICKER_CHOICES.length,
        confirm: confirmModePicker,
        close: closeModePicker,
        requestRender
      })
      // 模式选择器比其它四个多一条：面板打开时 Shift+Tab 继续循环，
      // 手感与面板关闭时按 Shift+Tab 一致。
      base.handlers.unshift({
        id: "cycle",
        when: on.key("tab"),
        run: ({ ui, key }) => {
          const delta = key.shift ? 1 : -1
          const count = MODE_PICKER_CHOICES.length
          ui.modePicker.selected = (ui.modePicker.selected + delta + count) % count
          requestRender()
        }
      })
      return base
    })()
  ]
}

function currentQuestion(ctx) {
  return (ctx.ui.pendingQuestion?.questions || [])[ctx.ui.questionIndex] || {}
}

function questionOptions(ctx) {
  const options = currentQuestion(ctx).options
  return Array.isArray(options) ? options : []
}

function maxOptionIndex(ctx) {
  const current = currentQuestion(ctx)
  return questionOptions(ctx).length + (current.allowCustom !== false ? 1 : 0) - 1
}
