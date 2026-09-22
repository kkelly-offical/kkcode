/**
 * 输入框里附件占位标记的强调色渲染。
 *
 * ## 为什么在帧层做而不是在排版层做
 *
 * 光标位置、换行、选区都按**原始字符串下标**在 util/text-layout.mjs 里算，
 * 提前给标记上色会让下标全部漂移。所以上色是排版之后的后处理：标记是纯 ASCII
 * 不含换行，落在单行内部；颜色序列零宽度，不改变任何宽度与光标记账。
 *
 * ## ANSI 安全
 *
 * 输入行里可能已经有别的 SGR（前缀提示符、选区反色、ghost 灰字）—— 它们都是
 * 自封口的码对。这里按「剥码后的可见下标 → 原串下标」映射插入颜色开/闭，
 * 不剥掉任何已有码；标记区间内若已含 ESC（比如正被框选），该区间跳过不上色 ——
 * 选区反色是更强的信号，让位给它。
 */

import { paint } from "../theme/color.mjs"
import { MARKER_PATTERN } from "./attachments.mjs"

const SGR_RE = /\x1b\[[0-9;]*m/g

/** 剥掉 SGR 后的第 visibleIndex 个字符，在原串里的下标。越界返回 -1。 */
function originalIndexAt(line, visibleIndex) {
  let visible = 0
  let i = 0
  while (i < line.length) {
    if (line.charCodeAt(i) === 0x1b) {
      SGR_RE.lastIndex = i
      const match = SGR_RE.exec(line)
      if (match && match.index === i) {
        i = SGR_RE.lastIndex
        continue
      }
      // 未识别的转义：按可见字符走，不越界读
    }
    if (visible === visibleIndex) return i
    visible += 1
    i += 1
  }
  return visible === visibleIndex ? i : -1
}

/**
 * 给一行已排版好的输入行里的附件标记上色。返回新串；没有标记或颜色不可用
 * 时返回原串（`===` 可断言，差分绘制不产生任何变化）。
 */
export function styleInputMarkers(line, { color, paintFn = paint } = {}) {
  if (!color || typeof line !== "string" || !line.includes("[")) return line
  const plain = line.replace(SGR_RE, "")
  const spans = []
  for (const match of plain.matchAll(new RegExp(MARKER_PATTERN.source, "g"))) {
    spans.push({ start: match.index, end: match.index + match[0].length })
  }
  if (!spans.length) return line

  let out = line
  // 从右往左插，左边的下标不受右边已插入内容影响
  for (const span of spans.reverse()) {
    const start = originalIndexAt(out, span.start)
    if (start < 0) continue
    // 区间在原串里的结束：从 start 起数 span.length 个可见字符
    let end = start
    let seen = 0
    while (end < out.length && seen < span.end - span.start) {
      if (out.charCodeAt(end) === 0x1b) break  // 区间内已有转义（选区等）→ 不上色
      end += 1
      seen += 1
    }
    if (seen < span.end - span.start) continue
    const open = paintFn("", color).replace("\x1b[0m", "")
    if (!open) continue  // 颜色不可用（NO_COLOR 等）时保持原样
    out = `${out.slice(0, start)}${open}${out.slice(start, end)}\x1b[0m${out.slice(end)}`
  }
  return out
}
