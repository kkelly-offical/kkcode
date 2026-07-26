/**
 * 输入框这一侧的附件动作：粘图、粘长文本、提交前解析。
 *
 * ## 为什么是一个模块而不是 startTuiRepl 里的三个闭包函数
 *
 * 结构守卫逼的 —— 塞进那个闭包会让它的判定点从 189 涨到 193，棘轮当场变红。
 * 但抽出来本身也是对的：折叠阈值（多长算长）是个迟早要调的旋钮，埋在两千行的
 * 闭包里既测不了也调不动。
 *
 * ## 与 attachments.mjs 的分工
 *
 * `attachments.mjs` 是登记本，只管存内容、认标记，不知道输入框的存在。
 * 这里是**策略**：什么时候折叠、标记插在哪、失效标记怎么提示。
 */

import { normalizeNewlines } from "./attachments.mjs"

/**
 * 折叠阈值。输入视口只有 5 行（frame-builder 按终端高度的 20% 算），粘 500 行
 * 进去等于把输入框炸掉；但折得太积极又会让人看不见自己粘了什么。
 * 取「已经溢出视口」附近：8 行或 600 字符。
 *
 * 两个触发条件都要：一整段没有换行的长文本行数恒为 1，只看行数就永远不折；
 * 而 20 行短代码字符数不多，只看字符数也会漏。撑爆视口的方式有两种。
 */
export const DEFAULT_FOLD_LINES = 8
export const DEFAULT_FOLD_CHARS = 600

export function createAttachmentInput({
  store,
  insertAtCursor,
  showToast,
  foldLines = DEFAULT_FOLD_LINES,
  foldChars = DEFAULT_FOLD_CHARS
}) {
  /**
   * 图片进登记本，在光标处插一个 `[Image #N]` 标记，返回标记文本。
   *
   * 标记本身就是「这里有张图」的提示：看得见、删得掉、位置明确。而且它是**唯一**
   * 决定这张图发不发的东西 —— 见 attachments.mjs 文件头的不变量。
   */
  function attachImage(block) {
    const { marker } = store.add({
      kind: "image",
      data: block.data,
      mediaType: block.mediaType,
      path: block.path
    })
    insertAtCursor(marker)
    return marker
  }

  /**
   * 粘贴文本的**唯一**入口 —— 括号粘贴与 Ctrl+V 的文本回落都走这里。
   *
   * 两条路径共用一份折叠策略，否则同一段文本从终端粘进来会折、从 Ctrl+V 进来不折，
   * 这种分叉用户无从解释。返回一句给调用方当提示语。
   */
  function insertPastedText(value) {
    const text = normalizeNewlines(value)
    if (!text) return "Clipboard is empty"
    const lines = text.split("\n").length
    if (lines < foldLines && text.length < foldChars) {
      insertAtCursor(text)
      return "Text pasted"
    }
    const { marker } = store.add({ kind: "text", text })
    insertAtCursor(marker)
    return `Pasted ${text.length} chars · ${marker}`
  }

  /**
   * 提交前把输入文本解析成「真正要发出去的文本 + 图片块」。
   *
   * 真相在文本里：文本里没提到的标记就是没被引用，登记本里存着也不发。所以这里没有
   * 「清空待发图片」这一步 —— 没有那个状态可清。
   *
   * 返回的形状就是 `processInputLine` 的两个入参名，调用方可以直接展开。
   */
  function resolveAttachments(text) {
    const { text: line, images, unresolved } = store.resolve(text)
    if (unresolved.length) {
      showToast(`${unresolved.length} 个附件标记已失效，按普通文字发送`, {
        topic: "clipboard",
        tone: "warning"
      })
    }
    return { line, pendingImages: images }
  }

  return { attachImage, insertPastedText, resolveAttachments }
}
