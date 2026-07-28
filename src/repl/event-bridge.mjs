/**
 * 会话事件 → TUI 状态。
 *
 * 这是引擎与界面之间唯一的桥：引擎发生什么都通过 EventBus 广播，界面在这里
 * 决定「这件事该怎么显示」。抽出来之后，「某个事件会改哪些 UI 字段」可以直接
 * 断言 —— 此前它是 startTuiRepl 闭包里一个 118 行的 switch，测不到。
 *
 * ## 事件必须先过归属判定
 *
 * `shouldApplyActiveTurnEvent` 挡住的是**别的会话或别的回合**的事件：后台任务
 * 与子智能体共用同一条总线，不判定的话它们的流式增量会画进当前对话。
 *
 * ## 通知（可选的 `notifier`）
 *
 * 这里只回答「什么时候值得把人叫回来」，不回答「怎么叫」—— 响铃/桌面通知/阈值
 * 全在 `repl/notify.mjs` 里。所以时长只量不判：`min_duration_ms` 在那边。
 * 权限与提问的通知不走这条链（它们是 `repl/prompt-queue.mjs` 的时机），
 * 这里只管回合生命周期与终端标题。
 *
 * ## 曾经在这里的一份死状态
 *
 * 这里原本还有一句 `ui.appState = reduceAppState(ui.appState, event)`。
 * `app-state.mjs` 是一套完整的 reducer，但**全代码库没有一处读 `ui.appState`** ——
 * 渲染完全走 `transcript` 模型。而它的 `appendBlock`/`appendDelta` 每次都全量
 * 复制数组，`stream.text.delta` 又是逐块到达的。
 *
 * 实测：200 轮之后它持有 2.8 MB、200 个 block，没有上限，会话开多久涨多久 ——
 * 全部为了一个没人读的值。已删除。`src/ui/app-state.mjs` 本身保留（reducer 是好的，
 * 有独立测试），将来若要接进渲染，从那里接。
 */

import { EVENT_TYPES } from "../core/constants.mjs"
import { shouldApplyActiveTurnEvent } from "../ui/event-scope.mjs"
import { formatTokenCount } from "../theme/status-bar.mjs"
import {
  startThinkingWait,
  startThinkingStream,
  appendThinkingDelta
} from "../ui/thinking-state.mjs"

const APP_TITLE = "kkcode"
const BUSY_MARK = "●"
/**
 * 标题写入的最小间隔。
 *
 * 真正压住流量的是「内容没变就不写」：一整段流式输出的标题文本是同一个串，
 * 一千个 delta 也只有第一次会写。这个间隔管的是另一种情况 —— 活动态在极短时间里
 * 反复横跳（快工具串行调用时 tool → thinking → tool …），每跳一次写一条 OSC 2。
 * 250ms 让最坏情况有上界，同时标题最多只落后四分之一秒。
 */
const TITLE_THROTTLE_MS = 250
// Esc / Ctrl+C 的中断在引擎里被分类成 aborted，但 TURN_ERROR 的载荷只带 message。
const ABORTED_MESSAGE_RE = /\babort(ed)?\b|stream cancelled/i

function projectNameFrom(cwd) {
  // 两种分隔符都切：Windows 上 cwd 是 `C:\Users\me\proj`
  const parts = String(cwd || "").split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : ""
}

/**
 * 终端标题的文本。忙碌时说正在做什么，空闲时说这是哪个项目。
 *
 * 前面那个 `●` 和输入行的忙碌指示是同一个符号：扫一眼标签页就知道它还在跑。
 */
export function describeReplTitle({ activity = null, cwd = "" } = {}) {
  if (activity?.type === "tool") return `${BUSY_MARK} ${APP_TITLE} · ${activity.tool || "tool"}`
  if (activity?.type === "writing") return `${BUSY_MARK} ${APP_TITLE} · writing`
  if (activity?.type === "retry") return `${BUSY_MARK} ${APP_TITLE} · retrying`
  if (activity?.type === "compacting") return `${BUSY_MARK} ${APP_TITLE} · compacting`
  if (activity) return `${BUSY_MARK} ${APP_TITLE} · thinking`
  const project = projectNameFrom(cwd)
  return project ? `${APP_TITLE} · ${project}` : APP_TITLE
}

function firstLineOf(text) {
  const line = String(text || "").split("\n").find((candidate) => candidate.trim())
  return line ? line.trim() : ""
}

/**
 * 这一轮是用户自己按 Esc / Ctrl+C 停的，还是真出错了。
 *
 * 中断不该弹通知：人就在键盘前，他刚按的键。按键处理器会先把 `ui.paused` 立起来，
 * 引擎随后才抛出 abort 错误走 TURN_ERROR —— 所以这一位在事件到达时是可信的。
 * 另外两条是给不经过按键的中断留的后路（退出流程、上游取消）。
 */
export function isUserInterruptedTurn(ui, payload) {
  if (ui?.paused === true) return true
  if (payload?.aborted === true) return true
  return ABORTED_MESSAGE_RE.test(String(payload?.error || payload?.message || ""))
}

/**
 * 标题写入器：去重 + 节流，并且知道「通知自己也会写标题」这件事。
 */
function createTitleWriter({ notifier, now }) {
  let last = null
  let lastAt = -Infinity

  return {
    write(text, { force = false } = {}) {
      if (!notifier || !text || text === last) return false
      const at = now()
      if (!force && at - lastAt < TITLE_THROTTLE_MS) return false
      last = text
      lastAt = at
      notifier.setTitle(text)
      return true
    },

    /**
     * `alert()` 内部会把标题写成通知文案（「kkcode · done — …」）。那条文案就是
     * 这一轮的空闲标题：把它登记成 `text`（调用方传空闲标题），后续任何一次
     * 「回到空闲」的同步都会被去重挡掉，而下一轮忙碌起来的标题照写。
     *
     * 少了这一步，回合结束后随便来一个非回合事件（压缩提示、MCP 心跳）都会把
     * 刚写上去的结果盖成项目名 —— 用户切回窗口时通知已经没了。
     */
    adopt(text) {
      last = text
      lastAt = now()
    }
  }
}

/**
 * @returns {Function} 取消订阅
 */
export function subscribeSessionEvents({
  eventBus,
  ui,
  ctx,
  state,
  toastStore,
  textStreamBatcher,
  requestRender,
  appendLog,
  showToast,
  applyThinkingTransition,
  finalizeThinking,
  finalizeTextStream,
  // 不传就完全不通知 —— 通知是可选通道，缺席时这里的行为和 0.7.2 之前一模一样
  notifier = null,
  /**
   * 空闲标题里的项目名。
   *
   * 这里原本写的是 `ctx.cwd` —— 而 `ctx` 上**根本没有这个字段**（全仓只有这一处
   * 引用它）。于是 `projectNameFrom(undefined)` 恒为空，标题永远退化成裸的
   * `kkcode`，项目名一次都没显示过。多开几个终端时，标签页正是靠它区分的。
   *
   * 显式参数是为了让这件事可断言：默认值取自调用方，测试直接喂一个路径。
   */
  cwd = process.cwd(),
  now = () => Date.now()
}) {
  const title = createTitleWriter({ notifier, now })
  // 回合时长的锚点。拿不到开始时间就不填 durationMs：notify 那边「拿不到时长
  // 就不打扰」是保守的正确读法，宁可少响一次。
  let turnStartedAt = null

  const syncTitle = (options) => title.write(describeReplTitle({
    // 回合在跑但还没有具体活动（TURN_START 到第一个 step 之间）也算忙碌
    activity: ui.activeTurnId ? (ui.currentActivity || { type: "thinking" }) : null,
    cwd
  }), options)

  /**
   * 回合终结时的唯一一次通知。
   *
   * 成功与失败各发一条、互斥：两条一起发的话，一次失败会响两遍铃、弹两个窗
   * （`turn-done` 受 min_duration_ms 约束，`error` 不受，所以它们不是同一条）。
   * 阈值判定留在 notify 模块里，这里只负责把 durationMs 量准。
   */
  const notifyTurnEnd = (type, payload) => {
    const durationMs = turnStartedAt === null ? undefined : now() - turnStartedAt
    turnStartedAt = null
    if (!notifier) return
    const interrupted = type === EVENT_TYPES.TURN_ERROR && isUserInterruptedTurn(ui, payload)
    const fired = interrupted
      ? null
      : type === EVENT_TYPES.TURN_ERROR
        ? notifier.alert("error", { message: payload?.error || payload?.message })
        : notifier.alert("turn-done", { durationMs, summary: firstLineOf(payload?.reply) })
    // 通知已经把结果写进标题了，别再拿空闲标题盖掉它 —— 那正是回合结束通知的全部意义
    if (fired?.title) title.adopt(describeReplTitle({ cwd }))
    // 一条都没发（时长不够、或被中断）时标题得自己收回空闲态，否则会一直停在
    // 「● kkcode · thinking」。强制写：回合结束是终态，被节流丢掉就再没有人来补。
    else syncTitle({ force: true })
  }

  return eventBus.subscribe((event) => {
    const { type, payload } = event
    // 后台任务与子智能体共用同一条总线；不判定归属的话它们的增量会画进当前对话
    if (!shouldApplyActiveTurnEvent(event, {
      sessionId: state.sessionId,
      turnId: ui.activeTurnId
    })) {
      return
    }

    switch (type) {
      case EVENT_TYPES.TURN_START:
        ui.activeTurnId = event.turnId || null
        turnStartedAt = now()
        break

      case EVENT_TYPES.TURN_STEP_START: {
        finalizeTextStream()
        applyThinkingTransition(startThinkingWait(ui.thinking, { now: now() }))
        ui.currentStep = payload.step || 0
        ui.maxSteps = Number(ctx.configState.config.agent?.max_steps) || 25
        ui.currentActivity = { type: "thinking" }
        requestRender()
        break
      }

      case EVENT_TYPES.TOOL_START:
        finalizeTextStream()
        finalizeThinking()
        ui.currentActivity = { type: "tool", tool: payload.tool, args: payload.args }
        requestRender()
        break

      case EVENT_TYPES.TOOL_FINISH:
      case EVENT_TYPES.TOOL_ERROR:
        ui.currentActivity = { type: "thinking" }
        requestRender()
        break

      case EVENT_TYPES.STREAM_TEXT_START:
        finalizeTextStream()
        finalizeThinking()
        ui.streamRaw = ""
        ui.streamLogId = appendLog("", { kind: "assistant", status: "streaming" })
        ui.currentActivity = { type: "writing" }
        requestRender()
        break

      case EVENT_TYPES.STREAM_TEXT_DELTA:
        // 增量只累积不重绘 —— 重绘由 batcher 按帧节流，否则每个 token 一帧
        ui.streamRaw += String(payload.text || payload.content || "")
        textStreamBatcher.schedule()
        break

      case EVENT_TYPES.STREAM_THINKING_START:
        finalizeTextStream()
        applyThinkingTransition(startThinkingStream(ui.thinking, { now: now() }))
        ui.currentActivity = { type: "thinking" }
        requestRender()
        break

      case EVENT_TYPES.STREAM_THINKING_DELTA: {
        const transition = appendThinkingDelta(
          ui.thinking,
          payload.text || payload.content || "",
          { now: now() }
        )
        ui.thinking = transition.state
        requestRender()
        break
      }

      case EVENT_TYPES.TURN_STEER_INJECTED:
        // 插话已进入回合 —— 上屏让用户看到它落在对话里的位置。
        // kind 用 user：它就是一条 user 消息，只是到达方式不同。
        appendLog(`❯ (插话) ${String(payload?.text || "")}`, { kind: "user" })
        showToast("插话已进入当前回合", { topic: "outbox", tone: "success" })
        requestRender()
        break

      case EVENT_TYPES.SESSION_COMPACTING:
        ui.currentActivity = { type: "compacting" }
        requestRender()
        break

      case EVENT_TYPES.SESSION_COMPACTED: {
        // 静默压缩 + 提示。压缩本身不打断工作流，这里只报一句结果。
        const before = Number(event.payload?.beforeTokens) || 0
        const after = Number(event.payload?.afterTokens) || 0
        const detail = before > 0 && after > 0
          ? `${formatTokenCount(before)} → ${formatTokenCount(after)}`
          : `${event.payload?.summarizedCount ?? "?"} messages summarized`
        showToast(`Context compacted · ${detail}`, { topic: "compaction", tone: "success" })
        // 压缩结束回到思考态 —— 但只收自己立起来的那一位：
        // 回合结束后迟到的 compacted 不该把 null 活动改回 thinking。
        if (ui.currentActivity?.type === "compacting") {
          ui.currentActivity = { type: "thinking" }
          requestRender()
        }
        break
      }

      case EVENT_TYPES.TURN_USAGE_UPDATE: {
        const usage = payload.usage || {}
        ui.metrics.tokenMeter = {
          ...ui.metrics.tokenMeter,
          estimated: true,
          turn: { input: usage.input || 0, output: usage.output || 0 }
        }
        // 渠道与模型的计价要等这一轮结束才确定。绝不能把写死的费率当成实时估算 ——
        // 那会给出一个看起来精确、实际是编的数字。
        ui.metrics.cost = null
        if (payload.context) ui.metrics.context = payload.context
        requestRender()
        break
      }

      case EVENT_TYPES.PROVIDER_RETRY:
        showToast(
          `Reconnecting ${payload.retryAttempt}/${payload.maxRetries} · ${payload.classification}`,
          {
            topic: "provider-retry",
            tone: "warning",
            durationMs: Math.max(1200, Number(payload.delayMs || 0) + 500)
          }
        )
        ui.currentActivity = {
          type: "retry",
          attempt: payload.retryAttempt,
          max: payload.maxRetries,
          classification: payload.classification
        }
        requestRender()
        break

      case EVENT_TYPES.TURN_FINISH:
      case EVENT_TYPES.TURN_ERROR:
        finalizeThinking()
        finalizeTextStream(type === EVENT_TYPES.TURN_ERROR ? "error" : undefined)
        // 重连提示要主动撤掉：回合已经结束了，留着它会让人以为还在重试
        toastStore.dismissTopic("provider-retry")
        ui.currentActivity = null
        ui.currentStep = 0
        ui.activeTurnId = null
        requestRender()
        notifyTurnEnd(type, payload)
        break
    }

    // 一处同步，而不是在每个 case 里各写一行 —— 漏掉哪个 case 都会让标题卡在旧状态。
    // 高频事件（每个 token 一个 delta）在这里靠「内容没变就不写」挡住。
    syncTitle()
  })
}
