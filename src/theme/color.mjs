const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  italic: "\u001b[3m",
  underline: "\u001b[4m"
}

const NAMED = {
  black: "\u001b[30m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  white: "\u001b[37m"
}

function hexToRgb(hex) {
  const raw = hex.replace("#", "")
  return {
    r: parseInt(raw.slice(0, 2), 16),
    g: parseInt(raw.slice(2, 4), 16),
    b: parseInt(raw.slice(4, 6), 16)
  }
}

function fgColorCode(color) {
  if (!color) return ""
  if (NAMED[color]) return NAMED[color]
  if (/^#([A-Fa-f0-9]{6})$/.test(color)) {
    const { r, g, b } = hexToRgb(color)
    return `\u001b[38;2;${r};${g};${b}m`
  }
  return ""
}

function bgColorCode(color) {
  if (!color) return ""
  if (NAMED[color]) {
    const fg = NAMED[color]
    return fg.replace("[3", "[4")
  }
  if (/^#([A-Fa-f0-9]{6})$/.test(color)) {
    const { r, g, b } = hexToRgb(color)
    return `\u001b[48;2;${r};${g};${b}m`
  }
  return ""
}

/**
 * 上色开关。
 *
 * 默认跟随环境（TTY 且未设 NO_COLOR），但可以显式覆盖 —— 这是**测试可见性**
 * 的前提：测试进程不是 TTY，`paint()` 于是恒返回原文，意味着任何配色回归在
 * CI 里完全观测不到（结构改动会红，颜色改错不会）。想断言配色的测试必须能
 * 打开它，用完在 after 钩子里 `setColorEnabled(null)` 还原。
 */
let colorOverride = null

export function setColorEnabled(value) {
  colorOverride = value === null || value === undefined ? null : Boolean(value)
}

export function isColorEnabled() {
  if (colorOverride !== null) return colorOverride
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
}

export function paint(text, color, options = {}) {
  const enabled = options.enabled === undefined ? isColorEnabled() : Boolean(options.enabled)
  if (!enabled) return text
  const styles = []
  if (options.bold) styles.push(ANSI.bold)
  if (options.dim) styles.push(ANSI.dim)
  if (options.italic) styles.push(ANSI.italic)
  if (options.underline) styles.push(ANSI.underline)
  const style = styles.join("")
  const fg = fgColorCode(color)
  const bg = bgColorCode(options.bg || null)
  if (!fg && !bg && !style) return text
  return `${style}${fg}${bg}${text}${ANSI.reset}`
}
