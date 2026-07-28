/**
 * 终端背景色探测（OSC 11）的**纯解析部分**。
 *
 * 发送与读取响应留给解码链 —— 这里只有「一串字节 → 背景是浅是深」的两步纯函数，
 * 因为那是唯一值得单测、也是唯一容易搞错的部分。
 *
 * ## 源码里不写字面控制字符
 *
 * ESC 与 BEL 一律用 \u001b / \u0007 转义写。裸控制字符在编辑器里不可见、会被
 * grep 与 diff 吃掉，粘贴时还可能被 shell 或终端吞掉一个字节 —— 那时正则悄悄
 * 匹配不上，而测试样本若也是复制粘贴来的就会跟着一起错，两边一致地错。
 *
 * ## 响应长什么样
 *
 * 标准答复是 `ESC ] 11 ; rgb:<r>/<g>/<b> ST`，其中：
 *   - 终止符 ST 可能是 BEL（\u0007）也可能是 `ESC \` —— 两种都得认；
 *   - 每个分量是 **1 到 4 位**十六进制，位宽由终端决定：xterm 给 16 位
 *     （`rgb:1e1e/1e1e/1e1e`），部分终端给 8 位（`rgb:1e/1e/1e`）。位宽不同
 *     意味着 `ffff` 与 `ff` 都表示满值 —— 必须按位宽归一化，不能直接截前两位；
 *   - 少数终端答 `rgba:` 带第四个分量，或者直接答 `#rrggbb`。
 */

/** 查询序列。**完整、可直接写进 stdout**，不需要调用方再拼 ESC 或终止符。 */
export const OSC11_QUERY = "\u001b]11;?\u0007"

/** `ESC ] 11 ;` 到终止符（BEL 或 `ESC \`）之间的载荷。 */
const OSC11_FRAME = /\u001b\]11;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/

/** `rgb:` / `rgba:` 形态，每个分量 1–4 位十六进制。 */
const RGB_PAYLOAD = /^rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?$/i

/** `#rgb` / `#rrggbb` / `#rrrgggbbb` / `#rrrrggggbbbb` 形态。 */
const HEX_PAYLOAD = /^#((?:[0-9a-f]{3}){1,4})$/i

/** 把 n 位十六进制分量归一到 0–255。 */
function scaleComponent(hex) {
  const max = 16 ** hex.length - 1
  return Math.round((parseInt(hex, 16) / max) * 255)
}

function parsePayload(payload) {
  const rgb = payload.match(RGB_PAYLOAD)
  if (rgb) {
    return { r: scaleComponent(rgb[1]), g: scaleComponent(rgb[2]), b: scaleComponent(rgb[3]) }
  }
  const hex = payload.match(HEX_PAYLOAD)
  if (!hex) return null
  const width = hex[1].length / 3
  return {
    r: scaleComponent(hex[1].slice(0, width)),
    g: scaleComponent(hex[1].slice(width, width * 2)),
    b: scaleComponent(hex[1].slice(width * 2))
  }
}

/**
 * 从终端响应里取出背景色。
 *
 * 认三种输入：完整响应（可以夹在一大段输入中间）、裸载荷（`rgb:…`，解码链可能
 * 已经把包头剥掉了）、以及带终止符但没包头的残片。认不出来返回 null ——
 * 调用方**必须**把 null 当「探测失败」处理，而不是当黑色。
 *
 * @param {string} text
 * @returns {{r: number, g: number, b: number} | null}
 */
export function parseOsc11Response(text) {
  const raw = String(text ?? "")
  const framed = raw.match(OSC11_FRAME)
  if (framed) return parsePayload(framed[1].trim())
  // 没有包头：把可能存在的前缀与终止符去掉后，当作裸载荷再试一次
  const bare = raw
    .replace(/^\u001b?\]11;/, "")
    .replace(/(?:\u0007|\u001b\\)\s*$/, "")
    .trim()
  if (!bare) return null
  return parsePayload(bare)
}

/**
 * BT.709 相对亮度（先做 sRGB 去伽马，再加权）。
 *
 * 不能对伽马编码后的值直接加权 —— 那样判定会落在肉眼几乎分不出的两个中灰之间：
 * `#767676` 得 0.46（深）而 `#808080` 得 0.50（浅）。
 */
export function relativeLuminance({ r, g, b }) {
  const channel = (value) => {
    const v = Math.min(255, Math.max(0, Number(value) || 0)) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/**
 * 背景是不是浅色。
 *
 * 阈值 0.5 取在相对亮度上，于是中灰（#808080，亮度 0.216）算深色。这是有意的
 * 保守：中灰底上浅色文字仍然读得清，反过来深色文字会糊。
 *
 * 传 null（探测失败）返回 false，即回落深色主题。
 */
export function isLightBackground(rgb) {
  if (!rgb || typeof rgb !== "object") return false
  return relativeLuminance(rgb) > 0.5
}
