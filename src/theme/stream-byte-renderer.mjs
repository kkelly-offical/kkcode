import { paint } from "./color.mjs"
import { createStreamRenderer } from "./markdown.mjs"
import { sanitizeTerminalText } from "../core/terminal-sanitize.mjs"
import { registerStreamByteRenderer } from "../session/render-stream.mjs"

/**
 * ANSI 流字节渲染器（1.0.0 阶段 3a 的 frontends sink，§7.5 双轨适配器）。
 *
 * 这里的每个方法都是从 session/loop.mjs 逐字搬来的原内联实现 —— 内核
 * （session/render-stream.mjs）现在只说语义（思考/正文/通知），着色与
 * markdown 渲染全部归前端。字节流与迁移前逐字节一致由
 * test/render-snapshot.test.mjs 的快照钉住。
 *
 * 生命周期与迁移前一致：每个 step 的 provider 流开始前 render 侧会调
 * beginStep() —— 等价于迁移前 loop 在 step 内新建 streamRenderer 并重置
 * inThinking/streamPhase/thinkingLineStart 的那几行。
 *
 * @param {object} options
 * @param {(text: string) => void} options.write 字节汇（旧 output 契约）
 * @param {boolean} [options.renderMarkdown] 等价迁移前的 mdEnabled
 */
export function createStreamByteRenderer({ write, renderMarkdown = true }) {
  let inThinking = false
  let thinkingLineStart = true
  let streamRenderer = null

  return {
    beginStep() {
      inThinking = false
      thinkingLineStart = true
      streamRenderer = renderMarkdown ? createStreamRenderer() : null
    },

    thinkingStart() {
      inThinking = true
      write(paint("●", "#666666") + " " + paint("Thinking", null, { dim: true }) + " " + paint("∨", null, { dim: true }) + "\n")
    },

    thinkingDelta(text) {
      // 只在行首加缩进，避免 chunk 中间出现多余空格
      const indented = sanitizeTerminalText(text).replace(/^|\n/g, (m) => {
        if (m === "\n") { thinkingLineStart = true; return "\n" }
        if (thinkingLineStart) { thinkingLineStart = false; return "  " }
        return ""
      })
      // 如果 chunk 末尾是换行，标记下一个 chunk 需要缩进
      if (text.endsWith("\n")) thinkingLineStart = true
      write(paint(indented, null, { dim: true }))
    },

    /** thinking 段结束、别的相位开始前的换行分隔。 */
    leaveThinking() {
      if (!inThinking) return
      inThinking = false
      write("\n")
    },

    textDelta(text) {
      if (streamRenderer) {
        const rendered = streamRenderer.push(text)
        if (rendered) write(rendered)
      } else {
        write(sanitizeTerminalText(text))
      }
    },

    providerCompaction() {
      write(paint("\n  ↻ context compacted by provider\n", "cyan", { dim: true }))
    },

    /** 流收尾：思考段补换行 → markdown 残余缓冲落盘 → 有正文则补段落换行。 */
    streamEnd(hadText) {
      if (inThinking) {
        inThinking = false
        write("\n")
      }
      if (streamRenderer) {
        const tail = streamRenderer.flush()
        if (tail) write(tail)
      }
      if (hadText) write("\n")
    },

    autoContinue(continueCount, maxContinues) {
      write(paint(`\n  ↳ output truncated, auto-continuing (${continueCount}/${maxContinues})...\n`, "yellow", { dim: true }))
    },

    validationSkipped(message) {
      write(paint(`\n  ⚠ Task validation skipped: ${message}\n`, "yellow", { dim: true }))
    }
  }
}

/**
 * 把 ANSI 字节渲染器登记进内核的渲染流槽（幂等）。凡是加载了主题/活动
 * 渲染器的前端进程，旧 output 字节轨随之可用；纯 headless 宿主不加载
 * 前端渲染代码，输出契约是 kernel 事件（render-stream.mjs 文件头注释）。
 */
export function installStreamByteRenderer() {
  registerStreamByteRenderer(createStreamByteRenderer)
}
