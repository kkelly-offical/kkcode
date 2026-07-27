/**
 * 工具层发起的两种模态提示：权限审批与提问。
 *
 * 它们和用户主动打开的浮层是**两回事**，所以不参与那六个浮层的互斥（见
 * `ui-state.mjs`）：这两种提示是一次工具调用**在等一个回答**，每一条背后都挂着
 * 一个没有 settle 的 Promise。顺手关掉一个，那次工具调用就永远悬着。
 *
 * ## 为什么要排队
 *
 * 并行的子智能体会同时要审批。没有队列的话，后到的提示会覆盖前一个，前一个的
 * Promise 永远等不到 resolve —— 表现是「有个后台任务卡住了，看不出为什么」。
 *
 * ## 退出时必须逐个 settle
 *
 * `settlePendingPromptsForExit` 在拆除界面之前把每一个都结掉：权限一律 fail
 * closed（deny），未答完的问题按「跳过」返回明确值。少结一个，等在那里的工具
 * 回合会在界面已经退出之后继续悬着，进程不退出。
 */

import { sanitizeTerminalValue } from "../theme/terminal-sanitize.mjs"
import { defaultPermissionChoiceIndex } from "./permission-flow.mjs"
import {
  activateNextQuestionState,
  commitQuestionAnswer,
  advanceQuestionState,
  finalizeQuestionAnswers
} from "./dialog-router.mjs"

/**
 * @param {object} p
 * @param {object|null} [p.notifier] 可选。工具在**等回答**时把用户叫回来 ——
 *   审批与提问一旦无人应答，那次工具调用就永远悬着。传 null 即完全不通知。
 */
export function createPromptQueue({ ui, requestRender, notifier = null }) {
  const defaultPermissionIndex = (perm) => defaultPermissionChoiceIndex(perm?.defaultAction)

  function queuePermissionPrompt(request) {
    // 不看时长：审批是**阻塞**的，等一秒和等一分钟都一样卡着
    notifier?.alert("permission", { tool: request?.tool || "" })
    ui.permissionQueue.push(request)
    if (!ui.pendingPermission) {
      ui.pendingPermission = ui.permissionQueue.shift() || null
      ui.permissionSelected = defaultPermissionIndex(ui.pendingPermission)
    }
    requestRender({ force: true })
  }

  function resolvePermissionPrompt(decision) {
    if (!ui.pendingPermission) return
    const current = ui.pendingPermission
    ui.pendingPermission = null
    ui.permissionSelected = 0
    // resolve 抛错不能把队列卡住 —— 后面还有别的调用在等
    try { current.resolve(decision) } catch {}
    if (ui.permissionQueue.length) {
      ui.pendingPermission = ui.permissionQueue.shift() || null
      ui.permissionSelected = defaultPermissionIndex(ui.pendingPermission)
    }
    requestRender({ force: true })
  }

  function queueQuestionPrompt(request) {
    notifier?.alert("question", { header: request?.questions?.[0]?.header || "" })
    ui.questionQueue.push({
      // 问题文本来自模型与工具，可能带终端控制序列
      ...request,
      questions: sanitizeTerminalValue(request?.questions || [])
    })
    if (!ui.pendingQuestion) activateNextQuestion()
    requestRender({ force: true })
  }

  function activateNextQuestion() {
    const next = activateNextQuestionState(ui.questionQueue)
    if (next.queue) ui.questionQueue = next.queue
    ui.pendingQuestion = next.pendingQuestion
    ui.questionIndex = next.questionIndex
    ui.questionOptionSelected = next.questionOptionSelected
    ui.questionMultiSelected = next.questionMultiSelected
    ui.questionCustomMode = next.questionCustomMode
    ui.questionCustomInput = next.questionCustomInput
    ui.questionCustomCursor = next.questionCustomCursor
    ui.questionAnswers = next.questionAnswers
  }

  function commitCurrentQuestionAnswer() {
    const next = commitQuestionAnswer({
      pendingQuestion: ui.pendingQuestion,
      questionIndex: ui.questionIndex,
      questionOptionSelected: ui.questionOptionSelected,
      questionMultiSelected: ui.questionMultiSelected,
      questionCustomMode: ui.questionCustomMode,
      questionCustomInput: ui.questionCustomInput,
      questionAnswers: ui.questionAnswers
    })
    ui.questionAnswers = next.questionAnswers
    ui.questionCustomMode = next.questionCustomMode
    ui.questionCustomInput = next.questionCustomInput
    ui.questionCustomCursor = next.questionCustomCursor
  }

  function advanceOrSubmitQuestion() {
    commitCurrentQuestionAnswer()
    const next = advanceQuestionState({
      pendingQuestion: ui.pendingQuestion,
      questionIndex: ui.questionIndex,
      questionOptionSelected: ui.questionOptionSelected,
      questionCustomMode: ui.questionCustomMode,
      questionCustomInput: ui.questionCustomInput,
      questionCustomCursor: ui.questionCustomCursor,
      // 下一题的编辑缓冲区要从答案里取回来（或取它的默认值），所以必须带上答案
      questionAnswers: ui.questionAnswers
    })
    if (next.shouldSubmit) {
      resolveQuestionPrompt()
      return
    }
    ui.questionIndex = next.questionIndex
    ui.questionOptionSelected = next.questionOptionSelected
    ui.questionCustomMode = next.questionCustomMode
    ui.questionCustomInput = next.questionCustomInput
    ui.questionCustomCursor = next.questionCustomCursor
    requestRender({ force: true })
  }

  function resolveQuestionPrompt() {
    if (!ui.pendingQuestion) return
    const current = ui.pendingQuestion
    const answers = finalizeQuestionAnswers(current, ui.questionAnswers)
    resetQuestionState()
    try { current.resolve(answers) } catch {}
    // 队列里还有就直接接上，不要让用户回到空屏再等下一个弹出来
    activateNextQuestion()
    requestRender({ force: true })
  }

  function resetQuestionState() {
    ui.pendingQuestion = null
    ui.questionIndex = 0
    ui.questionOptionSelected = 0
    ui.questionMultiSelected = {}
    ui.questionCustomMode = false
    ui.questionCustomInput = ""
    ui.questionCustomCursor = 0
    ui.questionAnswers = {}
  }

  /** 当前问题是不是在等自由文本（自定义模式，或该问题本来就没有选项）。 */
  function questionAcceptsTextInput() {
    if (!ui.pendingQuestion) return false
    const questions = ui.pendingQuestion.questions || []
    const current = questions[ui.questionIndex] || {}
    const options = Array.isArray(current.options) ? current.options : []
    return ui.questionCustomMode || options.length === 0
  }

  function insertQuestionText(value) {
    if (!questionAcceptsTextInput()) return false
    const text = String(value || "").replace(/\r\n?/g, "\n")
    if (!text) return false
    const cursor = Math.max(0, Math.min(ui.questionCustomInput.length, ui.questionCustomCursor))
    ui.questionCustomInput =
      ui.questionCustomInput.slice(0, cursor) + text + ui.questionCustomInput.slice(cursor)
    ui.questionCustomCursor = cursor + text.length
    return true
  }

  /**
   * 拆除界面之前把每一个模态都结掉。
   *
   * 权限一律 fail closed（deny）；未答完的问题按「跳过」返回明确值。少结一个，
   * 等在那里的工具回合会在界面退出之后继续悬着，进程不退出。
   */
  function settlePendingPromptsForExit() {
    const permissions = [
      ...(ui.pendingPermission ? [ui.pendingPermission] : []),
      ...ui.permissionQueue
    ]
    ui.pendingPermission = null
    ui.permissionQueue = []
    ui.permissionSelected = 0
    for (const permission of permissions) {
      try { permission.resolve("deny") } catch {}
    }

    const questions = [
      ...(ui.pendingQuestion ? [{ request: ui.pendingQuestion, answers: ui.questionAnswers }] : []),
      ...ui.questionQueue.map((request) => ({ request, answers: {} }))
    ]
    // 先清空状态再逐个 resolve：resolve 可能同步触发新的排队
    ui.questionQueue = []
    resetQuestionState()
    for (const { request, answers } of questions) {
      try { request.resolve(finalizeQuestionAnswers(request, answers)) } catch {}
    }
  }

  return {
    queuePermissionPrompt,
    resolvePermissionPrompt,
    queueQuestionPrompt,
    activateNextQuestion,
    commitCurrentQuestionAnswer,
    advanceOrSubmitQuestion,
    resolveQuestionPrompt,
    questionAcceptsTextInput,
    insertQuestionText,
    settlePendingPromptsForExit,
    pendingCount: () =>
      (ui.pendingPermission ? 1 : 0) + ui.permissionQueue.length +
      (ui.pendingQuestion ? 1 : 0) + ui.questionQueue.length
  }
}
