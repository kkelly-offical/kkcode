/**
 * 用户主动打开的那几个浮层（`USER_OVERLAY_KINDS`）的开/关/确认。
 *
 * 互斥由 `ui-state.mjs` 的 `openUserOverlay` 保证 —— 开一个就关掉其余全部。
 * 这里管的是各自的内容与确认动作。
 *
 * ## 确认时不要复制一份切换逻辑
 *
 * 渠道选择器与会话选择器确认时，把等价的斜杠命令填进输入框走正常提交路径：
 *
 *     ui.input = `/provider ${chosen.name}`
 *     await submitCurrentInput()
 *
 * 看起来绕，但切渠道要重取模型目录、校验凭据、回写状态；续跑要恢复渠道、模型、
 * 历史。那些逻辑只应存在一处 —— 在选择器里再实现一遍，两份迟早会分叉，而且
 * 分叉的那一半没有测试覆盖。
 *
 * 模型与模式选择器不走这条路，因为它们的确认就是改两个字段，没有第二份逻辑
 * 可言。判断标准是「这个动作有没有一条既有的命令路径」，不是「代码长不长」。
 */

import { openUserOverlay, closeUserOverlay } from "./ui-state.mjs"
import { createPickerFilterState, resolvePickerChoice } from "../ui/overlay-select.mjs"
import { createModePickerState, resolveModeId, MODE_PICKER_CHOICES } from "./mode-flow.mjs"
import { createPolicyPickerState, POLICY_CHOICES, applyPolicyChoice } from "./permission-flow.mjs"
import { stripAnsi } from "./frame-primitives.mjs"

export function createOverlayController({
  ui,
  state,
  ctx,
  requestRender,
  showToast,
  submitCurrentInput,
  selectModeAndNotify,
  clearPermissionSession,
  terminalColumns = () => Number(process.stdout.columns) || 120,
  // 主题切换器（repl/theme-switch.mjs）。可选：行模式与不带换肤能力的宿主
  // 可以不传，那时主题选择器打不开而不是崩在按键上。
  themeSwitcher = null
}) {
  /**
   * 四个列表型选择器的共同形状：空列表给提示、打开时预选当前项、关闭时强制重绘。
   * @param {string} kind
   * @param {object} p
   * @param {{message: string, topic: string, tone?: string, durationMs?: number}} p.emptyToast
   * @param {Function} [p.currentIndex] (items) => 当前项下标，缺省 0
   */
  function listPicker(kind, { emptyToast, currentIndex = () => -1 }) {
    return {
      open(items = []) {
        if (!items.length) {
          showToast(emptyToast.message, {
            topic: emptyToast.topic,
            tone: emptyToast.tone || "warn",
            durationMs: emptyToast.durationMs
          })
          requestRender()
          return false
        }
        // 打字过滤的状态与列表在一起：`all` 是原始候选，`items` 是渲染方
        // 看到的那份（过滤后就是过滤结果）。见 ui/overlay-select.mjs。
        openUserOverlay(ui, kind, createPickerFilterState(items, Math.max(0, currentIndex(items))))
        requestRender({ force: true })
        return true
      },
      close() {
        closeUserOverlay(ui, kind)
        requestRender({ force: true })
      },
      /** 取出选中项并关闭浮层。返回 null 表示没有可确认的东西。 */
      take() {
        const picker = ui[kind]
        if (!picker?.items) return null
        // 过滤态下 items 里是 label 标了方括号的副本，确认要的是原件
        const chosen = resolvePickerChoice(picker)
        closeUserOverlay(ui, kind)
        if (!chosen) requestRender({ force: true })
        return chosen
      }
    }
  }

  const providerPicker = listPicker("providerPicker", {
    emptyToast: { message: "没有已配置的 provider · /provider add 添加", topic: "provider" },
    currentIndex: (items) => items.findIndex((item) => item.name === state.providerType)
  })

  const sessionPicker = listPicker("sessionPicker", {
    emptyToast: { message: "没有可续跑的会话", topic: "session" }
  })

  const modelPicker = listPicker("modelPicker", {
    emptyToast: {
      message: "No models discovered · use /model <model-id>",
      topic: "model",
      tone: "error",
      durationMs: 5000
    },
    currentIndex: (items) =>
      items.findIndex((item) => item.model === state.model && item.provider === state.providerType)
  })

  /** 把等价的斜杠命令填进输入框并提交 —— 见文件头「不要复制一份切换逻辑」。 */
  async function submitAsCommand(command) {
    ui.input = command
    ui.inputCursor = ui.input.length
    await submitCurrentInput()
  }

  async function confirmProviderPicker() {
    const chosen = providerPicker.take()
    if (!chosen) return
    if (chosen.name === state.providerType) {
      showToast(`Provider · ${chosen.name}（已是当前渠道）`, { topic: "provider" })
      requestRender({ force: true })
      return
    }
    await submitAsCommand(`/provider ${chosen.name}`)
  }

  async function confirmSessionPicker() {
    const chosen = sessionPicker.take()
    if (!chosen) return
    await submitAsCommand(`/resume ${chosen.id}`)
  }

  function confirmModelPicker() {
    if (!ui.modelPicker) return
    const chosen = modelPicker.take()
    if (chosen) {
      state.providerType = chosen.provider
      state.model = chosen.model
      showToast(`Model · ${chosen.provider} / ${chosen.model}`, { topic: "model", tone: "success" })
    }
    requestRender({ force: true })
  }

  /**
   * 打开只读信息浮层。
   *
   * 与 `print(text, { channel: "panel" })` 的区别是它**不进对话记录**：
   * `/status`、`/permission` 这类查询当前状态的输出是给人看的，进了对话记录就会
   * 随会话一起发给模型，还会被 /clear 连带清掉，看完也关不掉。
   */
  function openInfoPanel(title, text, { maxRows = 14 } = {}) {
    // text 可以是函数：内容自己画框时需要知道浮层内宽，否则外层折行会把它的
    // 边框折断。内宽 = 终端宽 − 左右边框与内边距（各 2 格）。
    const innerWidth = Math.max(20, terminalColumns() - 4)
    const resolved = typeof text === "function" ? text(innerWidth) : text
    openUserOverlay(ui, "infoPanel", {
      title,
      lines: String(resolved ?? "").split("\n"),
      offset: 0,
      maxOffset: 0,
      maxRows,
      // 记下排版时的宽度：终端 resize 后据此重算，而不是让内容错位
      renderedAt: innerWidth,
      source: typeof text === "function" ? text : null,
      // 传函数意味着「我会按给定宽度自己排版」—— 即自带边框。这种内容超宽时
      // 必须裁掉右边而不是折行，否则它画的框会被折成两段（窄终端实测踩过）。
      wrap: typeof text !== "function"
    })
    requestRender({ force: true })
  }

  function closeInfoPanel() {
    if (!ui.infoPanel) return false
    closeUserOverlay(ui, "infoPanel")
    requestRender({ force: true })
    return true
  }

  function scrollInfoPanel(delta) {
    if (!ui.infoPanel) return
    // maxOffset 由渲染层回写 —— 内容有多长要排完版才知道
    const max = Number(ui.infoPanel.maxOffset) || 0
    ui.infoPanel.offset = Math.max(0, Math.min(max, (ui.infoPanel.offset || 0) + delta))
    requestRender()
  }

  /** resize 后重排自带边框的内容，否则新宽度下它的框会被折断。 */
  function relayoutInfoPanel() {
    if (!ui.infoPanel?.source) return false
    const innerWidth = Math.max(20, terminalColumns() - 4)
    if (innerWidth === ui.infoPanel.renderedAt) return false
    const resolved = ui.infoPanel.source(innerWidth)
    ui.infoPanel.lines = String(resolved ?? "").split("\n")
    ui.infoPanel.renderedAt = innerWidth
    ui.infoPanel.offset = 0
    return true
  }

  function openModePicker() {
    openUserOverlay(ui, "modePicker", createModePickerState(state.modeId || resolveModeId(state.mode)))
    requestRender({ force: true })
  }

  function closeModePicker() {
    closeUserOverlay(ui, "modePicker")
    requestRender({ force: true })
  }

  function confirmModePicker() {
    if (!ui.modePicker) return
    const chosen = MODE_PICKER_CHOICES[ui.modePicker.selected]
    closeModePicker()
    if (chosen) selectModeAndNotify(chosen.value)
  }

  function openPolicyPicker() {
    openUserOverlay(ui, "policyPicker", createPolicyPickerState(ctx.configState.config.permission || {}))
    requestRender({ force: true })
  }

  function closePolicyPicker() {
    closeUserOverlay(ui, "policyPicker")
    requestRender({ force: true })
  }

  function confirmPolicyPicker() {
    if (!ui.policyPicker) return
    const chosen = POLICY_CHOICES[ui.policyPicker.selected]
    if (chosen) {
      const permission = ctx.configState.config.permission || (ctx.configState.config.permission = {})
      const result = applyPolicyChoice(chosen, {
        permissionConfig: permission,
        sessionId: state.sessionId,
        clearSession: clearPermissionSession
      })
      ctx.configState.config.permission = result.permissionConfig
      if (result.message) {
        showToast(stripAnsi(result.message), { topic: "permission", tone: "success" })
      }
    }
    closePolicyPicker()
  }

  /**
   * 主题选择器。它与另外五个有一处不同：**选中即预览**。
   *
   * 颜色是唯一一种「描述不出来、只能看」的设置 —— 让人选中 light 之后先按 Enter
   * 再判断好不好看，等于每换一次都要来回开关浮层。所以上下键就把主题真的换上去，
   * 只是不落盘；Enter 才写配置，Esc 还原成打开浮层那一刻的主题。
   *
   * `restore` 记的是**打开时**的 id 而不是「上一次预览的」：连按五下箭头之后
   * Esc 要回到起点，不是回到第四下。
   */
  function openThemePicker() {
    if (!themeSwitcher) return false
    const items = themeSwitcher.list()
    if (!items.length) {
      showToast("没有可切换的主题", { topic: "theme", tone: "warn" })
      requestRender()
      return false
    }
    openUserOverlay(ui, "themePicker", {
      items,
      selected: Math.max(0, items.findIndex((item) => item.current)),
      restore: themeSwitcher.current()
    })
    requestRender({ force: true })
    return true
  }

  /** 上下键移动之后的即时预览：换画面，不写配置。 */
  function previewThemePicker() {
    if (!themeSwitcher || !ui.themePicker) return
    const chosen = ui.themePicker.items[ui.themePicker.selected]
    if (!chosen) return
    themeSwitcher.apply(chosen.id, { persist: false })
  }

  /** Esc / 外部关闭：把预览过的主题还原回打开时那个。 */
  function closeThemePicker() {
    const restore = ui.themePicker?.restore
    closeUserOverlay(ui, "themePicker")
    if (themeSwitcher && restore) themeSwitcher.apply(restore, { persist: false })
    requestRender({ force: true })
  }

  function confirmThemePicker() {
    if (!ui.themePicker) return
    const chosen = ui.themePicker.items[ui.themePicker.selected]
    // 先关再切：closeThemePicker 会还原，这里不能走它
    closeUserOverlay(ui, "themePicker")
    if (themeSwitcher && chosen) {
      themeSwitcher.apply(chosen.id)
      showToast(`Theme · ${chosen.label}`, { topic: "theme", tone: "success" })
    }
    requestRender({ force: true })
  }

  return {
    openProviderPicker: providerPicker.open,
    closeProviderPicker: providerPicker.close,
    confirmProviderPicker,
    openSessionPicker: sessionPicker.open,
    closeSessionPicker: sessionPicker.close,
    confirmSessionPicker,
    openModelPicker: modelPicker.open,
    closeModelPicker: modelPicker.close,
    confirmModelPicker,
    openInfoPanel,
    closeInfoPanel,
    scrollInfoPanel,
    relayoutInfoPanel,
    openModePicker,
    closeModePicker,
    confirmModePicker,
    openPolicyPicker,
    closePolicyPicker,
    confirmPolicyPicker,
    openThemePicker,
    closeThemePicker,
    confirmThemePicker,
    previewThemePicker
  }
}
