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

import { normalizeNewlines, formatCharCount, formatByteSize } from "./attachments.mjs"

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

/** 媒体 kind 的人读标签（toast 用；标记文本的表在 attachments.mjs）。 */
const MEDIA_LABEL = { image: "Image", video: "Video", audio: "Audio" }

export function createAttachmentInput({
  store,
  insertAtCursor,
  showToast,
  foldLines = DEFAULT_FOLD_LINES,
  foldChars = DEFAULT_FOLD_CHARS,
  /**
   * 当前模型收不收得下某类媒体：true 支持 / false 不支持 / null 未知。
   * 缺省只认 image 为已知支持（provider 适配层今天只会序列化 image 块）；
   * 其余按「未知」处理 —— 挂上标记但附警告，提交时再拦。能力面见
   * provider-catalog.mjs 的 modelMediaSupport。
   */
  supportsMedia = (kind) => (kind === "image" ? true : null)
}) {
  /**
   * 媒体进登记本，在光标处插一个 `[Image #N · 230 kB]` 标记，返回标记文本。
   *
   * 标记本身就是「这里有个附件」的提示：看得见、删得掉、位置明确。而且它是**唯一**
   * 决定这个附件发不发的东西 —— 见 attachments.mjs 文件头的不变量。
   *
   * 明确不支持该媒体的模型：不挂标记、直接报错（「明确提示而不是静默丢弃」）。
   * 能力未知的 video/audio：挂上标记并警告 —— 发送前的 resolve 还会再拦一次。
   */
  function attachMedia(block) {
    const kind = MEDIA_LABEL[block?.type] ? block.type : "image"
    const support = supportsMedia(kind)
    if (support === false) {
      showToast(`${MEDIA_LABEL[kind]} not attached — the current model does not accept ${kind} input`, {
        topic: "clipboard",
        tone: "error",
        durationMs: 4200
      })
      return null
    }
    const { marker } = store.add({
      kind,
      data: block.data,
      mediaType: block.mediaType,
      path: block.path,
      bytes: block.bytes
    })
    insertAtCursor(marker)
    if (support === null) {
      showToast(`${MEDIA_LABEL[kind]} attached · ${marker} — 当前模型的 ${kind} 支持未知，不支持时发送前会拦下`, {
        topic: "clipboard",
        tone: "warning",
        durationMs: 4200
      })
    }
    return marker
  }

  const attachImage = (block) => attachMedia(block)

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
    return `Pasted ${formatCharCount(text.length)} · ${marker}`
  }

  /**
   * 提交前把输入文本解析成「真正要发出去的文本 + 媒体块」。
   *
   * 真相在文本里：文本里没提到的标记就是没被引用，登记本里存着也不发。所以这里没有
   * 「清空待发图片」这一步 —— 没有那个状态可清。
   *
   * 当前模型收不下的媒体（video/audio 在能力未知或不支持时）在这里被拦下：
   * 不进待发数组，而是换成一句人话留在文本里 + 一条 toast —— provider 适配层
   * 序列化不了它们，静默丢掉用户无从知晓。
   *
   * 返回的形状就是 `processInputLine` 的两个入参名，调用方可以直接展开。
   */
  function resolveAttachments(text) {
    const resolved = store.resolve(text)
    let line = resolved.text
    const pendingImages = []
    const dropped = []
    for (const block of resolved.images) {
      const kind = block?.type
      if (supportsMedia(kind) === true) {
        pendingImages.push(block)
      } else {
        dropped.push(kind)
      }
    }
    if (dropped.length) {
      const kinds = [...new Set(dropped)].join("/")
      const note = `[${dropped.length} ${kinds} attachment(s) not sent — the current model does not accept ${kinds} input]`
      line = line ? `${line}\n${note}` : note
      showToast(`${dropped.length} 个 ${kinds} 附件未随消息发出 —— 当前模型不支持该类型输入`, {
        topic: "clipboard",
        tone: "warning",
        durationMs: 4200
      })
    }
    if (resolved.unresolved.length) {
      showToast(`${resolved.unresolved.length} 个附件标记已失效，按普通文字发送`, {
        topic: "clipboard",
        tone: "warning"
      })
    }
    return { line, pendingImages }
  }

  return { attachImage, attachMedia, insertPastedText, resolveAttachments, formatByteSize }
}
