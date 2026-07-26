import {
  createBracketedPasteDecoder,
  createFocusDecoder,
  createSgrMouseDecoder,
  createUtf8TextDecoder
} from "./terminal-protocol.mjs"

/**
 * stdin 的解码链：鼠标 → 焦点 → 括号粘贴。
 *
 * 三层各自会为了跨 chunk 切分**扣住**尾部的歧义字节（一个 chunk 可能正好断在
 * `ESC` 之后），所以谁在谁前面是有意义的，不能随手换顺序：
 *
 * - 焦点上报排在括号粘贴**之前**：否则 `ESC [ I` 会掉进粘贴载荷里，而漏进
 *   readline 的话那个 `I` 会直接变成一个字符插进输入框 —— 用户切回窗口，
 *   输入框里凭空多了个字母。
 * - 鼠标排在最前，同理：`ESC [ < 0 ; 4 ; 7 M` 不能被当成粘贴内容。
 *
 * 关掉的那一层是**透传**，不是「跳过但顺手改一下文本」—— 鼠标关掉时仍然要有人
 * 做 UTF-8 边界缓冲，否则被 chunk 切开的多字节字符会碎成替换符。
 */
export function createInputDecoderChain({ features = {}, onMouseEvent, onFocus } = {}) {
  const mouseEnabled = Boolean(features.mouse)
  const focusEnabled = Boolean(features.focusReporting)
  const pasteEnabled = Boolean(features.bracketedPaste)

  const mouseDecoder = createSgrMouseDecoder()
  const focusDecoder = createFocusDecoder()
  const pasteDecoder = createBracketedPasteDecoder()
  // 鼠标解码器自带 UTF-8 缓冲；关掉它之后这一层顶上，链的入口始终能收 Buffer。
  const plainTextDecoder = createUtf8TextDecoder()

  function throughFocus(text) {
    if (!focusEnabled) return text
    const focused = focusDecoder.feed(text)
    for (const ev of focused.events) onFocus?.(ev.focused)
    return focused.text
  }

  function throughPaste(text) {
    if (!pasteEnabled) return { text, pastes: [] }
    const pasted = pasteDecoder.feed(text)
    return { text: pasted.text, pastes: pasted.pastes }
  }

  return {
    /** @returns {{text: string, pastes: string[], mouseEvents: number}} */
    feed(chunk) {
      const mouse = mouseEnabled
        ? mouseDecoder.feed(chunk)
        : { events: [], text: plainTextDecoder.feed(chunk) }
      for (const ev of mouse.events) onMouseEvent?.(ev)
      const pasted = throughPaste(throughFocus(mouse.text))
      return { ...pasted, mouseEvents: mouse.events.length }
    },

    hasPending() {
      return (mouseEnabled && mouseDecoder.hasPending()) ||
        (focusEnabled && focusDecoder.hasPending()) ||
        (pasteEnabled && pasteDecoder.hasPending())
    },

    /**
     * 放出三层各自扣着的字节（转义超时的兜底）。
     *
     * 每一层扣着的东西只经过它**下游**的层。焦点这一层尤其不能把 flush 出来的文本
     * 再喂回链首：孤立的 `ESC` 是 `ESC [ I` 的合法前缀，会被同一个解码器再次扣住，
     * 原地打转 —— 那个 ESC 和紧跟着的下一个键就一起消失了。
     *
     * @returns {{text: string, pastes: string[], mouseEvents: number}}
     */
    flush() {
      const buffered = mouseEnabled ? mouseDecoder.flush() : plainTextDecoder.flush()
      let text = throughFocus(buffered)
      if (focusEnabled) text += focusDecoder.flush()
      const pasted = throughPaste(text)
      if (!pasteEnabled) return { ...pasted, mouseEvents: 0 }
      const tail = pasteDecoder.flush()
      return {
        text: pasted.text + tail.text,
        pastes: pasted.pastes.concat(tail.pastes),
        mouseEvents: 0
      }
    },

    reset() {
      mouseDecoder.reset()
      focusDecoder.reset()
      pasteDecoder.reset()
      plainTextDecoder.reset()
    }
  }
}
