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
  now = () => Date.now()
}) {
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

      case EVENT_TYPES.SESSION_COMPACTED: {
        // 静默压缩 + 提示。压缩本身不打断工作流，这里只报一句结果。
        const before = Number(event.payload?.beforeTokens) || 0
        const after = Number(event.payload?.afterTokens) || 0
        const detail = before > 0 && after > 0
          ? `${formatTokenCount(before)} → ${formatTokenCount(after)}`
          : `${event.payload?.summarizedCount ?? "?"} messages summarized`
        showToast(`Context compacted · ${detail}`, { topic: "compaction", tone: "success" })
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
        ui.currentActivity = { type: "thinking" }
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
        break
    }
  })
}
