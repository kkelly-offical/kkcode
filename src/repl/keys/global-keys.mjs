/**
 * 全局按键：生命周期、复制/中断、滚动。
 *
 * 这些作用域**非模态**，而且排在浮层之外的两侧：
 *
 *   lifecycle（浮层之前）—— Ctrl+Z 挂起、Ctrl+C 的三种含义、Ctrl+D 退出。
 *     它们必须先于浮层：浮层开着时也得能挂起和退出。
 *
 *   scroll（浮层之后、忙碌闸门之前）—— 翻页与跳转。刻意放在闸门之前：
 *     模型正在生成时用户仍然要能往回翻看内容。
 *
 * ## Ctrl+C 的三种含义
 *
 * 有可见选区 → 复制；忙碌 → 中断当前回合；空闲 → 两秒内连按两次才退出。
 * 顺序不能反：选区存在时如果先撞上「中断」，用户框选一段文字想复制，结果把
 * 正在跑的回合掐了。
 */

import { on } from "../key-dispatch.mjs"

export function createLifecycleKeyScope({
  requestRender,
  appendLog,
  showToast,
  finishSelection,
  copyToClipboard,
  suspendForJobControl,
  requestExit,
  state,
  doubleCtrlCWindowMs = 2000
}) {
  return {
    id: "lifecycle",
    handlers: [
      {
        id: "suspend",
        // Windows 没有 SIGTSTP，那里 Ctrl+Z 应当落到别处
        when: (ctx) => ctx.key.ctrl && ctx.key.name === "z" && process.platform !== "win32",
        run: () => suspendForJobControl()
      },
      {
        id: "copyMouseSelection",
        when: (ctx) => ctx.key.ctrl && ctx.key.name === "c" && Boolean(ctx.ui.mouseSelection),
        run: () => { finishSelection(true); requestRender() }
      },
      {
        id: "copyInputSelection",
        when: (ctx) => ctx.key.ctrl && ctx.key.name === "c" && Boolean(ctx.ui.inputSelection),
        run: ({ ui }) => {
          const start = Math.min(ui.inputSelection.start, ui.inputSelection.end)
          const end = Math.max(ui.inputSelection.start, ui.inputSelection.end)
          void copyToClipboard(ui.input.slice(start, end))
          requestRender()
        }
      },
      {
        id: "interruptOrExit",
        when: on.ctrl("c"),
        run: ({ ui }) => {
          if (ui.busy) {
            if (ui.turnAbortController) {
              ui.turnAbortController.abort()
              ui.turnAbortController = null
            }
            ui.paused = true
            appendLog(state.mode === "agent"
              ? "[paused] agent turn interrupted — enter a follow-up message to continue the same task"
              : "[paused] turn interrupted — enter a new message or command to continue")
            requestRender()
            return
          }
          // 空闲时要求两秒内连按两次 —— 单次 Ctrl+C 误退出的代价是丢掉整个会话
          const now = Date.now()
          if (now - ui.lastCtrlCTime < doubleCtrlCWindowMs) {
            requestExit()
          } else {
            ui.lastCtrlCTime = now
            showToast("Press Ctrl+C again to exit", { topic: "exit", tone: "warning" })
            requestRender()
          }
        }
      },
      {
        id: "exitOnEmpty",
        // 输入框非空时 Ctrl+D 不退出：那通常是想删字符
        when: (ctx) => ctx.key.ctrl && ctx.key.name === "d" && ctx.ui.input.length === 0,
        run: () => requestExit()
      }
    ]
  }
}

export function createScrollKeyScope({
  requestRender,
  scrollBy,
  scrollToTop,
  scrollToBottom,
  pageSize,
  appendLog,
  state
}) {
  return {
    id: "scroll",
    handlers: [
      {
        id: "pageUp",
        when: on.key("pageup"),
        run: ({ ui }) => { scrollBy(pageSize(ui.scrollMeta.logRows)); requestRender() }
      },
      {
        id: "pageDown",
        when: on.key("pagedown"),
        run: ({ ui }) => { scrollBy(-pageSize(ui.scrollMeta.logRows)); requestRender() }
      },
      {
        id: "lineUpDown",
        when: (ctx) => ctx.key.ctrl && (ctx.key.name === "up" || ctx.key.name === "down"),
        run: ({ key }) => { scrollBy(key.name === "up" ? 3 : -3); requestRender() }
      },
      {
        id: "toTop",
        when: (ctx) => ctx.key.name === "home" && (ctx.key.ctrl || ctx.key.shift),
        run: () => { scrollToTop(); requestRender() }
      },
      {
        id: "toBottom",
        when: (ctx) => ctx.key.name === "end" && (ctx.key.ctrl || ctx.key.shift),
        run: () => { scrollToBottom(); requestRender() }
      },
      {
        id: "pauseTurn",
        // 忙碌时的 Esc 与 Ctrl+C 同义。它排在忙碌闸门之前，否则中断不了。
        when: (ctx) => ctx.key.name === "escape" && ctx.ui.busy,
        run: ({ ui }) => {
          if (ui.turnAbortController) {
            ui.turnAbortController.abort()
            ui.turnAbortController = null
          }
          ui.paused = true
          appendLog(state.mode === "agent"
            ? "[paused] agent turn interrupted — enter a follow-up message to continue the same task"
            : "[paused] turn interrupted — enter a new message or command to continue")
          requestRender()
        }
      }
    ]
  }
}
