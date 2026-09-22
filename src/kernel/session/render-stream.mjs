import { EVENT_TYPES } from "../core/constants.mjs"

/**
 * 回合渲染流（1.0.0 阶段 3a，M3 耦合点 14 的收尾）。
 *
 * loop 的用户可见输出在这里纯化为**数据事件**：思考/正文的起止与增量、
 * 流内工具调用、provider 端压缩提示、流结束、自动续写与验证跳过通知，
 * 全部经 kernel 事件总线发射（2b 桥会把它带进 kernel 实例总线），宿主用
 * registerSink/subscribe 消费。ANSI 着色与 markdown 渲染不属于内核。
 *
 * 双轨（§7.5 回退单元）：旧 `output` 参数（{ write, renderMarkdown } 字节
 * 契约）保留一个 minor —— 前端经 registerStreamByteRenderer 登记字节渲染器
 * 后，本模块把同样的语义调用驱动到该渲染器，产出与迁移前逐字节一致的
 * ANSI 流。未登记时字节轨静默（headless 宿主的输出契约是事件，不是字节）。
 * 双轨删除安排在 1.0.0 收尾，走 deprecations.mjs 公告。
 */

let streamByteRendererFactory = null

/**
 * 前端登记字节渲染器工厂。每个入口进程最多登记一次（幂等：重复登记同一
 * 工厂无副作用）。调用点：theme/load-theme.mjs 的 loadTheme() 与
 * ui/activity-renderer.mjs（kkcode ultra 入口不经过 loadTheme）。
 *
 * @param {null|((options: { write: (text: string) => void, renderMarkdown: boolean }) => object)} factory
 */
export function registerStreamByteRenderer(factory) {
  streamByteRendererFactory = typeof factory === "function" ? factory : null
}

/** 诊断/测试用：当前进程是否已有前端登记字节渲染器。 */
export function hasStreamByteRenderer() {
  return streamByteRendererFactory !== null
}

/**
 * 每个回合一个渲染流。方法都是 async —— 数据事件经 eventBus.emit 顺序发出，
 * 与字节轨的相对顺序和迁移前 loop.mjs 内联实现逐点对应（快照测试钉住）。
 *
 * @param {object} options
 * @param {null|{ write?: Function, renderMarkdown?: boolean }} options.output 旧字节汇（双轨）
 * @param {boolean} options.renderMarkdown 等价迁移前的 mdEnabled
 * @param {{ emit: (event: object) => Promise<object> }} options.eventBus
 * @param {string} options.sessionId
 * @param {string} options.turnId
 */
export function createRenderStream({ output = null, renderMarkdown = true, eventBus, sessionId, turnId }) {
  const write = output && typeof output.write === "function" ? output.write : null
  const bytes = write && streamByteRendererFactory
    ? streamByteRendererFactory({ write: (text) => write(text), renderMarkdown })
    : null

  // 流相位与迁移前 loop 的 streamPhase 同生命周期：每个 step 一次 provider
  // 流，beginStep 重置。thinking 段、text 段、tool_call 段之间的切换点
  // （含「thinking 段后再来 text 段要重发 text.start」）全部由它派生。
  let phase = null
  let sawText = false
  // 回合终态闸：turn.finish / turn.error 发出后 loop 就 return 了，按构造
  // 不该再有任何渲染调用 —— 但「按构造」挡不住未来的漂移与异步迟到者。
  // close() 之后所有方法静默归零，让「turn 结束后不再产出流式/thinking
  // 事件」成为可测试的结构性保证，而不是一个巧合。
  let closed = false

  function close() {
    closed = true
  }

  function beginStep() {
    if (closed) return
    phase = null
    sawText = false
    bytes?.beginStep?.()
  }

  async function thinkingDelta(step, text) {
    if (closed) return
    if (phase !== "thinking") {
      phase = "thinking"
      await eventBus.emit({ type: EVENT_TYPES.STREAM_THINKING_START, sessionId, turnId, payload: { step } })
      bytes?.thinkingStart?.()
    }
    await eventBus.emit({ type: EVENT_TYPES.STREAM_THINKING_DELTA, sessionId, turnId, payload: { step, text } })
    bytes?.thinkingDelta?.(text)
  }

  async function textDelta(step, text) {
    if (closed) return
    if (phase === "thinking") bytes?.leaveThinking?.()
    if (phase !== "text") {
      phase = "text"
      await eventBus.emit({ type: EVENT_TYPES.STREAM_TEXT_START, sessionId, turnId, payload: { step } })
    }
    await eventBus.emit({ type: EVENT_TYPES.STREAM_TEXT_DELTA, sessionId, turnId, payload: { step, text } })
    sawText = true
    bytes?.textDelta?.(text)
  }

  async function toolCallChunk(step, call) {
    if (closed) return
    if (phase === "thinking") bytes?.leaveThinking?.()
    phase = "tool_call"
    await eventBus.emit({
      type: EVENT_TYPES.STREAM_TOOL_CALL,
      sessionId,
      turnId,
      payload: { step, id: call?.id ?? null, name: call?.name ?? null }
    })
  }

  async function providerCompaction(step) {
    if (closed) return
    await eventBus.emit({ type: EVENT_TYPES.STREAM_PROVIDER_COMPACTION, sessionId, turnId, payload: { step } })
    bytes?.providerCompaction?.()
  }

  /** provider 流正常收尾（错误/中断路径不调用 —— 与迁移前一致，残余缓冲直接丢弃）。 */
  async function streamEnd(step) {
    if (closed) return
    await eventBus.emit({ type: EVENT_TYPES.STREAM_END, sessionId, turnId, payload: { step } })
    bytes?.streamEnd?.(sawText)
  }

  async function autoContinue(step, { continueCount, maxContinues }) {
    if (closed) return
    await eventBus.emit({
      type: EVENT_TYPES.TURN_AUTO_CONTINUE,
      sessionId,
      turnId,
      payload: { step, continueCount, maxContinues }
    })
    bytes?.autoContinue?.(continueCount, maxContinues)
  }

  async function validationSkipped(step, message) {
    if (closed) return
    await eventBus.emit({
      type: EVENT_TYPES.TURN_VALIDATION_SKIPPED,
      sessionId,
      turnId,
      payload: { step, message: String(message || "") }
    })
    bytes?.validationSkipped?.(message)
  }

  return {
    beginStep,
    thinkingDelta,
    textDelta,
    toolCallChunk,
    providerCompaction,
    streamEnd,
    autoContinue,
    validationSkipped,
    close
  }
}
