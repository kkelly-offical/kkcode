/**
 * 回合生命周期的显式状态机（渲染层）。
 *
 * ## 为什么需要它
 *
 * 此前回合状态是散落在 event-bridge 与 repl.mjs 各 finally 里的五个字段
 * （busy / activeTurnId / currentActivity / currentStep / turnAbortController），
 * 每个结束路径各自手写一遍复位。漏一个字段的后果是用户看得见的：
 * TURN_FINISH（事件侧清了活动态）到 submitCurrentInput 的 finally（才清 busy）
 * 之间有一个窗口期，`busy && !currentActivity` 在 frame-builder 里回落成
 * "Starting…/Working…" —— 回合明明结束了，屏幕上却像又开始思考。
 *
 * 现在相位是一等状态：`idle → starting → active → finishing → idle`。
 * 结束路径（正常结束 / 出错 / 中断 / 审批拒绝导致的工具失败收尾）全部经
 * `noteTurnEnded` + `resetTurnRuntime` 同一个收口，不存在「这条路径忘了清」。
 *
 * 这里只管**呈现状态**。思考流的归档在 ui/thinking-state.mjs，流式正文条目在
 * event-bridge 里收尾 —— 两者都有自己的完成语义，不归这里管。
 */

import { EVENT_TYPES } from "../kernel/index.mjs"

export const TURN_PHASES = Object.freeze(["idle", "starting", "active", "finishing"])

/**
 * 本地提交了一个回合（用户回车 / 队列排干 / 后台唤醒）。TURN_START 还没到达，
 * 屏幕上是「已受理、尚未开工」—— 与回合结束后的 finishing 窗口是两回事。
 */
export function markTurnSubmitted(ui) {
  ui.busy = true
  ui.turnPhase = "starting"
  ui.currentActivity = null
  ui.currentStep = 0
}

/**
 * 回合事件 → 相位与活动态。返回值表示呈现状态是否有变化（供调用方决定是否重绘）。
 *
 * 事件归属（别会话/迟到的回合事件）由 ui/event-scope.mjs 挡在前面，这里假设
 * 事件已经是「当前前台回合」的。会话级事件（压缩）不按回合挡。
 */
export function reduceTurnRuntime(ui, event, { maxSteps } = {}) {
  const { type, payload = {} } = event || {}
  switch (type) {
    case EVENT_TYPES.TURN_START:
      ui.activeTurnId = event.turnId || null
      ui.turnPhase = "active"
      return true
    case EVENT_TYPES.TURN_STEP_START:
      ui.turnPhase = "active"
      ui.currentStep = payload.step || 0
      if (maxSteps !== undefined) ui.maxSteps = maxSteps
      ui.currentActivity = { type: "thinking" }
      return true
    case EVENT_TYPES.TOOL_START:
      ui.currentActivity = { type: "tool", tool: payload.tool, args: payload.args }
      return true
    case EVENT_TYPES.TOOL_FINISH:
    case EVENT_TYPES.TOOL_ERROR:
      // 工具收尾到下一 step 之间是「在思考」，不是「空闲」
      ui.currentActivity = { type: "thinking" }
      return true
    case EVENT_TYPES.STREAM_TEXT_START:
      ui.currentActivity = { type: "writing" }
      return true
    case EVENT_TYPES.PROVIDER_RETRY:
      ui.currentActivity = {
        type: "retry",
        attempt: payload.retryAttempt,
        max: payload.maxRetries,
        classification: payload.classification
      }
      return true
    case EVENT_TYPES.SESSION_COMPACTING:
      ui.currentActivity = { type: "compacting" }
      return true
    case EVENT_TYPES.SESSION_COMPACTED:
      // 只收自己立起来的那一位；回合已结束（finishing/idle）时不得把活动态
      // 复活成 thinking —— 那正是「结束后又在思考」的可见形态之一。
      if (ui.currentActivity?.type === "compacting") {
        ui.currentActivity = ui.turnPhase === "active" ? { type: "thinking" } : null
        return true
      }
      return false
    case EVENT_TYPES.TURN_FINISH:
    case EVENT_TYPES.TURN_ERROR:
      ui.activeTurnId = null
      ui.currentActivity = null
      ui.currentStep = 0
      // 本地回合还有「呈现结果」一段路要走（turn-presenter 打文件变更/诊断），
      // 此刻 busy 仍为 true —— 相位是 finishing，不再是 starting。
      // 远程回合没有本地的提交-收尾路径，这里直接落定。
      ui.turnPhase = ui.remoteTurn ? "idle" : "finishing"
      return true
    default:
      return false
  }
}

/**
 * 确定性复位到 idle。submitCurrentInput 的 finally、退出前清理都走这里 ——
 * 「回合彻底结束了」只有一个写法，没有第二条路径可以漏清某个字段。
 */
export function resetTurnRuntime(ui) {
  ui.busy = false
  ui.turnPhase = "idle"
  ui.activeTurnId = null
  ui.currentActivity = null
  ui.currentStep = 0
  ui.turnAbortController = null
}

/** 空闲帧缺省相位。旧状态对象（测试里手搓的 ui）没有 turnPhase 时按 idle 读。 */
export function turnPhaseOf(ui) {
  return TURN_PHASES.includes(ui?.turnPhase) ? ui.turnPhase : "idle"
}
