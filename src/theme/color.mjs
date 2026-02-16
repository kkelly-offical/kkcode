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

export function paint(text, color, options = {}) {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return text
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
