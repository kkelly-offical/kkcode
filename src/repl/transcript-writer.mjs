/**
 * 输出的入口：一条消息按性质进对话记录、瞬时提示，还是折叠面板。
 *
 * ## 为什么由调用点声明通道，而不是猜
 *
 * 0.6.0 之前这里靠**正则嗅探**决定一条消息是提示还是对话记录 —— 只认四个英文
 * 动词加 `switched:`，中文文案与多行输出一律漏网。于是 `/help`（80+ 行）、
 * `/status`、`/board` 的看板全都灌进对话记录，还会被 `/clear` 一起清掉。
 * 现在通道由调用点显式给出，猜不出来就是调用点没说清楚。
 *
 * ## 为什么所有文本都要过消毒
 *
 * 对话记录里的内容有相当一部分来自**模型与工具输出**：文件名、命令回显、
 * 错误信息。这些都可能带终端控制序列 —— 一个 `\x1b[2J` 能清屏，一个 OSC 序列
 * 能改窗口标题。`sanitizeTerminalStyledText` 保留颜色码但拆掉危险序列，
 * `sanitizeTerminalValue` 对结构化字段递归处理。
 */

import {
  sanitizeTerminalText,
  sanitizeTerminalStyledText,
  sanitizeTerminalValue
} from "../theme/terminal-sanitize.mjs"
import { stripAnsi } from "./frame-primitives.mjs"

export function createTranscriptWriter({ transcript, toastStore }) {
  /** 把一条记录（字符串或结构化对象）消毒成可以安全渲染的形态。 */
  function sanitizeRecord(input, options = {}) {
    const source = input && typeof input === "object" && !Array.isArray(input)
      ? { ...input, ...options }
      : { ...options, summary: String(input ?? "").replace(/\r/g, "") }
    const safe = sanitizeTerminalValue(source)
    // 这三个字段是要显示给人看的，保留颜色码；其余字段按值消毒
    for (const key of ["summary", "title", "text"]) {
      if (source[key] !== undefined) safe[key] = sanitizeTerminalStyledText(source[key])
    }
    if (source.details !== undefined) {
      const details = Array.isArray(source.details) ? source.details : [source.details]
      safe.details = details.flatMap((line) =>
        sanitizeTerminalStyledText(line).split(/\r?\n/)
      )
    }
    return safe
  }

  function appendLog(text = "", options = {}) {
    return transcript.appendLog(sanitizeRecord(text, options))
  }

  function updateLog(id, patch) {
    if (!patch || typeof patch !== "object") return transcript.updateLog(id, patch)
    return transcript.updateLog(id, sanitizeRecord(patch))
  }

  function showToast(message, { topic = "status", tone = "info", durationMs } = {}) {
    return toastStore.show(sanitizeTerminalText(message), { topic, tone, durationMs })
  }

  /**
   * 命令与事件输出的统一出口。
   *
   * @param {string} text
   * @param {{channel?: "transcript"|"notice"|"panel", topic?: string, tone?: string, title?: string}} options
   * @returns {string|null} 对话记录条目 id；瞬时提示没有 id，返回 null
   */
  function print(text = "", options = {}) {
    const channel = options.channel || "transcript"
    if (channel === "notice") {
      showToast(stripAnsi(text).trim(), {
        topic: options.topic || "status",
        tone: options.tone || "success"
      })
      return null
    }
    if (channel === "panel") {
      // 面板类输出折叠成一条可展开的条目：占一行，展开才铺开，既不刷屏也不丢内容。
      // 注意这仍然在**对话记录里** —— 只读查询该走信息浮层（见 ui/overlay-panel.mjs），
      // 这个通道只剩行模式（无 TTY，没有帧可浮）的回落一个正当用途。
      const lines = String(text).split("\n")
      return appendLog({
        summary: options.title || lines[0] || "output",
        details: lines.length > 1 ? lines.slice(options.title ? 0 : 1) : [],
        kind: "system",
        collapsible: lines.length > 1
      })
    }
    return appendLog(text)
  }

  return { appendLog, updateLog, showToast, print, sanitizeRecord }
}
