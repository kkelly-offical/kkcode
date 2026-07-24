import { requestFast, isFastModelConfigured } from "../provider/fast-model.mjs"
import { sanitizeTerminalText } from "../theme/terminal-sanitize.mjs"

/**
 * 输入框 ghost text：用 models.fast 预测用户「这句话接下来要写什么」。
 *
 * 目标不是补全代码，而是补完用户正在敲的这一句自然语言指令，所以只取
 * 一行、限长、并且必须与触发时的输入完全一致才会被采纳（陈旧结果一律
 * 丢弃）。未配置 models.fast 时整个功能关闭，不会退到主模型。
 */

export const GHOST_DEBOUNCE_MS = 350
export const GHOST_MAX_LENGTH = 80
const GHOST_MIN_INPUT = 3

const SYSTEM_PROMPT = [
  "You complete the sentence the user is currently typing into a coding assistant's input box.",
  "",
  "Rules:",
  "- Output ONLY the continuation, never repeat what the user already typed",
  "- One short line, at most 12 words",
  "- Same language as the user's text",
  "- No quotes, no explanation, no formatting, no trailing punctuation",
  "- If the text already reads like a complete instruction, output nothing"
].join("\n")

/** 该不该为这段输入发起预测。 */
export function shouldPredict(input, { enabled = true, busy = false, modal = false } = {}) {
  if (!enabled || busy || modal) return false
  const text = String(input || "")
  if (text.length < GHOST_MIN_INPUT) return false
  if (text.trimStart().startsWith("/") || text.trimStart().startsWith("$")) return false
  // 已经以空白结尾说明用户正在停顿换词，此时补全最没有价值
  if (/\s$/.test(text)) return false
  return true
}

/** 模型返回值 → 可直接渲染的 ghost 文本；不合格时返回空串。 */
export function normalizeGhost(raw, input = "") {
  const firstLine = String(raw || "").split("\n").find((line) => line.trim()) || ""
  let text = sanitizeTerminalText(firstLine).trim()
  if (!text) return ""
  // 模型有时会把用户已输入的部分重复一遍
  const typed = String(input || "").trim()
  if (typed && text.toLowerCase().startsWith(typed.toLowerCase())) {
    text = text.slice(typed.length)
  }
  text = text.replace(/^["'“”]+|["'“”]+$/g, "").replace(/\s+/g, " ")
  if (!text.trim()) return ""
  // 用户没打空格结尾时补一个，视觉上才连得起来
  const needsSpace = /\S$/.test(String(input || "")) && /^\S/.test(text)
  return (needsSpace ? ` ${text}` : text).slice(0, GHOST_MAX_LENGTH)
}

export function ghostEnabled(configState) {
  const setting = String(configState?.config?.ui?.composer?.ghost_text ?? "auto").toLowerCase()
  if (setting === "off" || setting === "false") return false
  return isFastModelConfigured(configState)
}

/**
 * 创建一个去抖预测器。宿主在每次输入变化时调用 schedule(input)，
 * 在提交、失焦、退出时调用 cancel()/dispose()。
 */
export function createGhostPredictor({
  configState,
  onGhost,
  debounceMs = GHOST_DEBOUNCE_MS,
  deps = {}
} = {}) {
  const request = deps.requestFast || requestFast
  const setTimer = deps.setTimer || setTimeout
  const clearTimer = deps.clearTimer || clearTimeout

  let timer = null
  let controller = null
  let baseInput = ""
  let disposed = false

  function cancel() {
    if (timer) {
      clearTimer(timer)
      timer = null
    }
    if (controller) {
      controller.abort()
      controller = null
    }
    baseInput = ""
  }

  async function run(input) {
    controller = new AbortController()
    const signal = controller.signal
    const text = await request({
      configState,
      system: SYSTEM_PROMPT,
      prompt: input,
      maxTokens: 32,
      signal
    })
    if (disposed || signal.aborted) return
    // 输入在请求途中变过 → 结果已经陈旧，丢弃
    if (input !== baseInput) return
    const ghost = normalizeGhost(text, input)
    if (ghost) onGhost?.(ghost, input)
  }

  return {
    schedule(input, context = {}) {
      if (disposed) return false
      cancel()
      if (!ghostEnabled(configState)) return false
      if (!shouldPredict(input, context)) return false
      baseInput = String(input)
      timer = setTimer(() => {
        timer = null
        void run(baseInput)
      }, debounceMs)
      return true
    },
    cancel,
    dispose() {
      disposed = true
      cancel()
    },
    get pending() {
      return Boolean(timer || controller)
    }
  }
}
