/**
 * TUI 的可变状态，以及浮层互斥不变量。
 *
 * ## 为什么浮层需要一个不变量
 *
 * 六个「用户主动打开」的浮层此前是六个各自独立的可空字段，谁都能直接赋值。
 * `repl.mjs:1697` 的注释声称 infoPanel「与选择器互斥」，但没有任何代码保证这件事。
 *
 * 而 `frame-builder` 的浮层是**叠加**的：每个非空块都会被拼进帧，`overlayRows`
 * 把它们的行数相加。两个浮层同开时两个都画出来，对话区被挤到最小的 2 行，
 * 而按键只有一个生效（按键的优先级顺序和渲染顺序还不一样）。
 *
 * 这是可达的：`/provider` 打开选择器之后，后台任务的 `question` 提示会异步到达。
 *
 * ## 为什么工具层的提示不参与这个互斥
 *
 * `pendingPermission` 与 `pendingQuestion` 不是用户打开的，是工具执行**在等回答**。
 * 它们有自己的队列，丢掉一个就意味着一次工具调用永远悬着。所以互斥只管用户
 * 主动打开的那六个：开一个，关掉另外五个。
 */

import { createAttachmentStore } from "./attachments.mjs"

import { createThinkingState } from "../ui/thinking-state.mjs"
import { createWizardState } from "../provider/wizard.mjs"

/** 用户主动打开、彼此互斥的浮层。 */
export const USER_OVERLAY_KINDS = Object.freeze([
  "infoPanel",
  "providerPicker",
  "sessionPicker",
  "modelPicker",
  "modePicker",
  "policyPicker"
])

/**
 * 工具层驱动的模态提示。不参与上面的互斥 —— 它们在等一个回答，
 * 被顺手关掉就等于把那次工具调用永远挂住。
 */
export const PROMPT_OVERLAY_KINDS = Object.freeze(["pendingPermission", "pendingQuestion"])

export function createReplUiState({ historyLines = [], terminalFeatures = {} } = {}) {
  const ui = {
    input: "",
    inputCursor: 0,
    busy: false,
    /**
     * 附件登记本。**它不记录「谁会被发送」** —— 那是输入文本里的标记说了算，
     * 见 attachments.mjs 的文件头。这里只存内容。
     */
    attachments: createAttachmentStore(),
    /** 忙碌时敲下的消息，回合结束后依次发出。见 repl/prompt-outbox.mjs。 */
    queuedPrompts: [],
    permissionQueue: [],
    pendingPermission: null,
    permissionSelected: 0,
    questionQueue: [],
    pendingQuestion: null,
    lastEscapeAt: 0,
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
    history: [...historyLines],
    historyIndex: historyLines.length,
    scrollOffset: 0,
    quitting: false,
    showDashboard: true,
    scrollMeta: {
      logRows: 0,
      totalRows: 0,
      maxOffset: 0
    },
    spinnerIndex: 0,
    currentActivity: null,
    currentStep: 0,
    maxSteps: 0,
    thinking: createThinkingState(),
    lastThinkingId: null,
    streamLogId: null,
    streamRaw: "",
    activeTurnId: null,
    paused: false,
    turnAbortController: null,
    lastCtrlCTime: 0,
    agentContinuation: null,
    lastLongAgentPrompt: null,
    longagentAborted: false,
    agentTransaction: null,
    agentAborted: false,
    pendingModeConfirm: null,
    // 鼠标文本选择状态
    mouseSelection: null,  // { startRow, startCol, endRow, endCol, active }
    autoCopy: terminalFeatures.copyOnSelect, // 全屏鼠标模式下默认选中即复制
    inputSelection: null,  // { start, end } 输入框内的选择范围（字符位置）
    inputDragAnchor: -1,   // 输入框拖拽起始字符位置
    ghostText: "",         // 小模型预测的下一句（纯视觉，不参与光标计算）
    inputLayout: null,
    // 屏幕布局元数据（buildFrame 中更新）
    layoutMeta: { logStartRow: 0, logEndRow: 0, inputStartRow: 0, inputEndRow: 0 },
    wizard: createWizardState(),
    providerPicker: null,
    sessionPicker: null,
    // 只读信息浮层：{ title, lines, offset, maxOffset, maxRows }
    infoPanel: null,
    metrics: {
      tokenMeter: {
        estimated: false,
        turn: { input: 0, output: 0 },
        session: { input: 0, output: 0 },
        global: { input: 0, output: 0 }
      },
      cost: null,
      context: null,
      longagent: null,
      toolEvents: []
    }
  }
  return ui
}

/**
 * 行模式下 `providerPicker` 被设成**字符串数组**（编号输入态），那不是浮层。
 * 判断浮层要看它是不是带 items 的对象 —— frame-builder 也是这么区分的。
 */
function isOverlayValue(kind, value) {
  if (!value) return false
  if (kind === "providerPicker" || kind === "sessionPicker" || kind === "modelPicker") {
    return Array.isArray(value.items)
  }
  return true
}

/** 当前打开的用户浮层，没有则 null。 */
export function activeUserOverlay(ui) {
  for (const kind of USER_OVERLAY_KINDS) {
    if (isOverlayValue(kind, ui[kind])) return kind
  }
  return null
}

/**
 * 打开一个用户浮层，同时关掉其余五个。
 *
 * 传 null 等于关掉它（此时不动其它浮层）。
 */
export function openUserOverlay(ui, kind, value) {
  if (!USER_OVERLAY_KINDS.includes(kind)) {
    throw new Error(`unknown overlay kind: ${kind}`)
  }
  if (value === null || value === undefined) {
    ui[kind] = null
    return null
  }
  for (const other of USER_OVERLAY_KINDS) {
    if (other !== kind) ui[other] = null
  }
  ui[kind] = value
  return kind
}

export function closeUserOverlay(ui, kind) {
  return openUserOverlay(ui, kind, null)
}

/** 关掉所有用户浮层。工具层的提示不动。 */
export function closeAllUserOverlays(ui) {
  for (const kind of USER_OVERLAY_KINDS) ui[kind] = null
}
