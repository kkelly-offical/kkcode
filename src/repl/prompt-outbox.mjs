/**
 * 待发队列：模型干活时敲下的消息，排到当前回合结束后依次发出。
 *
 * ## 为什么需要它
 *
 * 此前整个编辑器作用域是 `active: (ctx) => !ctx.ui.busy` —— 回合进行中，用户敲的
 * 每一个字符都被直接丢弃。想到下一句话只能干等，等完还得重新打一遍。
 *
 * ## 为什么是一个模块而不是 startTuiRepl 里的几行
 *
 * 结构守卫盯着 `submitCurrentInput`（86 个判定点）与 `startTuiRepl`（189），两个都是
 * **只减不增**的棘轮。排干队列的循环写进任何一个都会让它变复杂，而这段逻辑本来就
 * 不依赖那两个闭包里的任何东西 —— 它只需要「把一条文本交出去」这一个动作。
 *
 * ## 真相放在 ui.queuedPrompts
 *
 * 与附件登记本同一个取向（见 attachments.mjs 文件头）：队列内容就存在 UI 状态里，
 * 帧直接读它渲染计数，没有第二份需要同步的副本。
 */

/** 队列上限。排太多说明用户在跟一个跑飞了的回合较劲，那时该中断而不是继续堆。 */
export const DEFAULT_MAX_QUEUED = 8

export function createPromptOutbox({
  ui,
  showToast,
  requestRender,
  maxQueued = DEFAULT_MAX_QUEUED
}) {
  if (!Array.isArray(ui.queuedPrompts)) ui.queuedPrompts = []

  /**
   * 排一条。**同步**，返回值调用方可以忽略 —— 去空白、判空、上限、提示都在这里做完。
   */
  function queue(text) {
    const value = String(text || "").trim()
    if (!value) return false
    if (ui.queuedPrompts.length >= maxQueued) {
      showToast(`待发队列已满（${maxQueued}）· 先按 Esc 中断当前回合`, {
        topic: "outbox",
        tone: "warning"
      })
      requestRender()
      return false
    }
    ui.queuedPrompts.push(value)
    showToast(`已排队（${ui.queuedPrompts.length}）· 当前回合结束后发送`, {
      topic: "outbox",
      tone: "info"
    })
    requestRender()
    return true
  }

  /**
   * 把队列排干。
   *
   * 用循环而不是递归：队列上限虽然只有 8，但「提交里再触发提交」这种形状在这个
   * 文件里已经有过一处（Plan→Build 交接，深度固定为 1），再叠一层就没人说得清
   * 栈上到底有几个回合了。
   *
   * 每轮**重新读** `ui.queuedPrompts`：排队期间用户可以继续加，也可以中断后清空 ——
   * 一次性拷出快照再遍历的话，中断之后剩下的还是会被发出去。
   */
  async function drain(submitOne) {
    while (ui.queuedPrompts.length) {
      const next = ui.queuedPrompts.shift()
      requestRender()
      await submitOne(next)
    }
  }

  /** 中断时调用。被丢掉的条数要说出来，否则用户不知道自己排的东西没了。 */
  function clear() {
    const dropped = ui.queuedPrompts.length
    if (!dropped) return 0
    ui.queuedPrompts.length = 0
    showToast(`已丢弃 ${dropped} 条待发消息`, { topic: "outbox", tone: "warning" })
    requestRender()
    return dropped
  }

  return {
    queue,
    drain,
    clear,
    size: () => ui.queuedPrompts.length,
    list: () => [...ui.queuedPrompts]
  }
}
