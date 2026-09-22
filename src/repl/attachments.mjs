/**
 * 附件登记本：粘贴进来的图片与折叠的长文本，加上它们在输入框里的内联标记。
 *
 * ## 唯一不变量：输入文本是「哪些附件会被发送」的唯一真相
 *
 * 登记本只负责**保存**内容，不负责记录**谁还活着**。提交时 `resolve(text)` 按输入
 * 文本里实际出现的标记来解析，登记本里存着但文本里没提到的条目就是没被引用 —— 它
 * 不需要被「移除」，它只是不在真相里。
 *
 * 把真相放在文本里，一整类同步问题就不存在了：
 *   - 删掉标记            = 取消这个附件
 *   - Ctrl+Z 恢复文本     = 附件跟着回来
 *   - 复制粘贴一个标记    = 同一张图被引用两次
 *   - 调换两个标记的顺序  = 调换发送顺序
 * 以上全部自然成立，不需要任何额外状态同步。
 *
 * 所以这里**故意不提供** `removeAttachment()` 之类的 API。一旦有了它，「谁会被发送」
 * 就同时写在两个地方（文本 + 登记本），两处迟早会不一致，而不一致的那一刻用户看到的
 * 是「我明明删了它却还是发出去了」。
 *
 * 同理，id 单调递增、永不复用（`reset()` 之后也不重置）：回收编号会让输入框里已经
 * 存在的标记悄悄指向另一个东西。
 *
 * ## 行尾
 *
 * 算行数与存原文之前一律 `\r\n?` → `\n` 归一。这是本项目在 Windows/POSIX 分歧上栽的
 * 第五个坑的预防：0.6.27 的结构守卫就是因为按 `\n` 切 CRLF 文本而在 Windows 上全红、
 * 在 Linux 上全绿。做法与注释风格见 `src/util/source-metrics.mjs`，测试同样写成**在
 * Linux 上也会红**的形态。
 */

export const IMAGE_KIND = "image"
export const TEXT_KIND = "text"
export const VIDEO_KIND = "video"
export const AUDIO_KIND = "audio"

/** 默认容量。超出后淘汰最早的条目 —— 剪贴板历史不值得无限占内存。 */
export const DEFAULT_MAX_ENTRIES = 32

/** kind ↔ 标记里的人类可读标签。两张表都在这里，免得两处拼写漂移。 */
const LABEL_BY_KIND = { [IMAGE_KIND]: "Image", [TEXT_KIND]: "Pasted text", [VIDEO_KIND]: "Video", [AUDIO_KIND]: "Audio" }
const KIND_BY_LABEL = { Image: IMAGE_KIND, "Pasted text": TEXT_KIND, Video: VIDEO_KIND, Audio: AUDIO_KIND }

/** 二进制媒体（image/video/audio）共用一个校验形状：base64 data 必备。 */
const MEDIA_KINDS = new Set([IMAGE_KIND, VIDEO_KIND, AUDIO_KIND])

/**
 * 标记的正则。**集成方与测试都用这一份，不要在别处重写。**
 *
 * 后缀段两种形态都认：
 *   - 现行：`· 2.8k chars`、`· 230 kB`、`· 12.4 MB`（1.0.1 起的人读格式）
 *   - 历史：`+1470 chars`（输入历史里可能躺着旧标记，del/解析不能因此失灵）
 *
 * 注意它带 `g` 标志，因而是有状态的（`lastIndex`）—— 直接复用这个实例去 `exec`/`test`
 * 会拿到取决于上次调用的结果。本模块内一律现克隆一个（见 `scanner()`），外部要用也
 * 请照做，或者只用 `String.prototype.replace` 这类会自己重置 lastIndex 的入口。
 */
export const MARKER_PATTERN = /\[(Image|Pasted text|Video|Audio) #(\d+)(?: (?:\+\d+ chars?|· [\d.,]+[kMG]? (?:chars?|[kMG]?B)))?\]/g

/** 现克隆一个无状态的扫描器。见 MARKER_PATTERN 的注释。 */
const scanner = () => new RegExp(MARKER_PATTERN.source, "g")

const asText = (value) => (typeof value === "string" ? value : String(value ?? ""))

/** 统一行尾。输入框内部就是 `\n`，存进来的原文也必须是。 */
export function normalizeNewlines(text) {
  return asText(text).replace(/\r\n?/g, "\n")
}

/** 归一之后再数行 —— 否则 CRLF 与 CR 会数出不同的值。 */
export function countTextLines(text) {
  return normalizeNewlines(text).split("\n").length
}

/**
 * 人读的规模格式（1.0.1）。输入框寸土寸金，标记里的数字要短而准：
 *
 *   字符：1 char / 600 chars / 2.8k chars / 25k chars
 *   字节：512 B / 230 kB / 12.4 MB / 1.5 GB
 *
 * 两种量纲各一套写法，全库只此一处 —— toast 文案与标记文本同源。
 */
export function formatCharCount(value) {
  const n = Math.max(0, Number(value) || 0)
  if (n === 1) return "1 char"
  if (n < 1000) return `${n} chars`
  const k = n / 1000
  const label = k < 10 ? (Math.round(k * 10) / 10).toFixed(1) : String(Math.round(k))
  return `${label}k chars`
}

export function formatByteSize(value) {
  const n = Math.max(0, Number(value) || 0)
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`
  if (n < 1024 * 1024 * 1024) {
    const mb = n / (1024 * 1024)
    return `${mb < 10 ? (Math.round(mb * 10) / 10).toFixed(1) : Math.round(mb)} MB`
  }
  return `${(Math.round(n / (1024 * 1024 * 1024) * 10) / 10).toFixed(1)} GB`
}

/** base64 串的字节数（标记上的规模标签用；末尾 padding 至多差 2 字节，人读级别够准）。 */
export function base64ByteSize(data) {
  const text = String(data || "")
  if (!text) return 0
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor(text.length * 3 / 4) - padding)
}

/**
 * 条目 → 插进输入框的标记文本。
 *
 *   { kind: "image", id: 1, bytes: 235520 }   -> "[Image #1 · 230 kB]"
 *   { kind: "text", id: 2, chars: 1470 }      -> "[Pasted text #2 · 1.5k chars]"
 *   { kind: "video", id: 3, bytes: 12976128 } -> "[Video #3 · 12.4 MB]"
 *   { kind: "audio", id: 4, bytes: 512 }      -> "[Audio #4 · 512 B]"
 *
 * 文本规模用字符数而不是行数：粘过来的东西常常是一整段没有换行的长文本，那时行数
 * 恒为 1、完全不说明问题；字符数对两种形态都成立。媒体规模用字节数：解码出
 * 分辨率/时长是内核的事，UI 层手里可靠的只有字节。
 */
export function formatMarker(entry) {
  const { kind, id, chars, bytes } = entry || {}
  const label = LABEL_BY_KIND[kind]
  if (!label) {
    throw new TypeError(`formatMarker: 不认识的 kind ${JSON.stringify(kind)}，支持 ${Object.keys(KIND_BY_LABEL).map((k) => `"${k}"`).join(" / ")}`)
  }
  if (kind === TEXT_KIND) return `[${label} #${id} · ${formatCharCount(chars)}]`
  const size = Number.isFinite(bytes) && bytes > 0 ? ` · ${formatByteSize(bytes)}` : ""
  return `[${label} #${id}${size}]`
}

/**
 * 词法解析：文本里出现的所有标记，按出现顺序。
 *
 * **只做词法，不查登记本** —— 用户手打的 `[Image #99]` 一样会被解析出来，是不是真有
 * 这么个附件由 `resolve` 去判断。这条边界让解析可以被独立测试，也让「未知 id 当普通
 * 文字处理」成为一个显式的决定而不是解析失败的副作用。
 *
 * @returns {Array<{id: number, kind: string, start: number, end: number, raw: string}>}
 *          start/end 是 JS 字符串索引，end 独占：`text.slice(start, end) === raw`
 */
export function parseMarkers(text) {
  const source = asText(text)
  const out = []
  for (const match of source.matchAll(scanner())) {
    out.push({
      id: Number(match[2]),
      kind: KIND_BY_LABEL[match[1]],
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0]
    })
  }
  return out
}

/**
 * 光标恰好在某个标记**右端**时返回该标记的 span，否则 null。
 *
 * 给退格键用：光标停在 `[Image #1]` 的 `]` 之后按退格，应当把整个标记一次删掉，而不是
 * 留下一个 `[Image #1` 的残骸 —— 残骸既不再匹配标记、又看不出发生了什么。
 * 只在右端命中；标记内部与左端都返回 null，因为那时用户的意图不明确。
 */
export function markerSpanAt(text, index) {
  for (const marker of parseMarkers(text)) {
    if (marker.end === index) return marker
  }
  return null
}

/** 交给下游的媒体内容块。字段与 `src/kernel/tool/image-util.mjs` 产出的块保持一致。 */
function toMediaBlock(entry) {
  const block = { type: entry.kind, data: entry.data, mediaType: entry.mediaType }
  if (entry.path !== undefined) block.path = entry.path
  return block
}

/** 入参校验集中在这里，`add` 才不会被一堆 if 淹掉。抛 TypeError 且说清缺了什么。 */
function validateEntry(entry) {
  const kind = entry?.kind
  if (!LABEL_BY_KIND[kind]) {
    throw new TypeError(`add: 不认识的 kind ${JSON.stringify(kind)}，支持 ${Object.keys(KIND_BY_LABEL).map((k) => `"${k}"`).join(" / ")}`)
  }
  if (MEDIA_KINDS.has(kind) && (typeof entry.data !== "string" || !entry.data)) {
    throw new TypeError(`add: kind "${kind}" 缺少 data（base64 字符串）`)
  }
  if (kind === TEXT_KIND && (typeof entry.text !== "string" || !entry.text)) {
    throw new TypeError('add: kind "text" 缺少 text（非空字符串）')
  }
  return kind
}

/**
 * 建一个登记本。
 *
 * @param {{maxEntries?: number}} [options]
 */
export function createAttachmentStore({ maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const cap = Number.isFinite(maxEntries) && maxEntries >= 1 ? Math.floor(maxEntries) : DEFAULT_MAX_ENTRIES
  /** @type {Map<number, object>} 插入顺序即年龄顺序，淘汰时取第一个 key。 */
  const entries = new Map()
  let nextId = 1

  /** 标记指向的条目是否可解析。kind 也要对得上：id 2 存的是文本时，`[Image #2]` 不算数。 */
  const entryFor = (marker) => {
    const entry = entries.get(marker.id)
    return entry && entry.kind === marker.kind ? entry : null
  }

  function add(entry) {
    const kind = validateEntry(entry)
    const id = nextId++
    const record = MEDIA_KINDS.has(kind)
      ? {
          id,
          kind,
          data: entry.data,
          mediaType: entry.mediaType,
          path: entry.path,
          // 标记上的规模标签。调用方没给字节数时从 base64 长度估一个
          bytes: Number.isFinite(entry.bytes) && entry.bytes > 0 ? entry.bytes : base64ByteSize(entry.data)
        }
      : {
          id,
          kind,
          text: normalizeNewlines(entry.text),
          // 两个规模都记下来：chars 进标记（给人看），lines 给折叠策略判断
          // 「会不会撑爆只有 5 行的输入视口」。
          chars: normalizeNewlines(entry.text).length,
          lines: countTextLines(entry.text)
        }
    // 冻结：登记本里的条目是只读的，`get()` 交出去也不怕被下游改。
    entries.set(id, Object.freeze(record))
    while (entries.size > cap) entries.delete(entries.keys().next().value)
    return { id, kind, marker: formatMarker(record) }
  }

  /**
   * 提交时调用：把输入文本解析成「要发出去的文本 + 图片块」。
   *
   * - image 且登记本里有：标记**原样留在文本里**（模型据此知道 `#1` 指的是句子里的哪
   *   个位置、对应哪张图），图片块追加进 images。同一 id 被引用两次就追加两次。
   * - text 且登记本里有：标记**替换成存储的原文**，逐字，不加任何包裹 —— 折叠纯粹是
   *   显示层的事，模型应当收到用户当初粘贴的东西。
   * - 未知 id（被淘汰了、或用户手打了一个假标记）：原样留在文本里当普通文字，并把 raw
   *   记进 unresolved。**不抛错也不静默吞掉** —— 用户打 `[Image #99]` 就应该是一句普通话。
   *
   * 没有任何标记时返回**原字符串本身**（`===` 可断言），保证绝大多数不带附件的回合走
   * 的是零开销路径。
   */
  function resolve(text) {
    const source = asText(text)
    const markers = parseMarkers(source)
    if (!markers.length) return { text: source, images: [], unresolved: [] }

    const parts = []
    const images = []
    const unresolved = []
    let cursor = 0
    for (const marker of markers) {
      parts.push(source.slice(cursor, marker.start))
      cursor = marker.end
      const entry = entryFor(marker)
      if (!entry) {
        parts.push(marker.raw)
        unresolved.push(marker.raw)
      } else if (MEDIA_KINDS.has(entry.kind)) {
        parts.push(marker.raw)
        images.push(toMediaBlock(entry))
      } else {
        parts.push(entry.text)
      }
    }
    parts.push(source.slice(cursor))
    return { text: parts.join(""), images, unresolved }
  }

  /** 文本里真正引用到、且登记本里存在的 id，按出现顺序去重。给 UI 计数与提交后清理用。 */
  function referencedIds(text) {
    const seen = new Set()
    for (const marker of parseMarkers(text)) {
      if (entryFor(marker)) seen.add(marker.id)
    }
    return [...seen]
  }

  return {
    add,
    get: (id) => entries.get(id),
    size: () => entries.size,
    /** 清空内容，但**不重置 id** —— 见文件头，回收编号会让已存在的标记指向别的东西。 */
    reset: () => entries.clear(),
    resolve,
    referencedIds
  }
}
