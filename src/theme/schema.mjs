const REQUIRED_GROUPS = ["base", "semantic", "modes", "components"]
const MODE_KEYS = ["assistant", "plan", "agent", "longagent"]
const HEX_RE = /^#([A-Fa-f0-9]{6})$/

function validateColor(value, path, errors) {
  if (typeof value !== "string" || !HEX_RE.test(value)) {
    errors.push(`${path} must be a hex color like #00ff00`)
  }
}

export function validateTheme(theme) {
  const errors = []
  if (!theme || typeof theme !== "object" || Array.isArray(theme)) {
    return { valid: false, errors: ["theme must be an object"] }
  }
  if (typeof theme.name !== "string" || theme.name.trim().length === 0) {
    errors.push("name must be a non-empty string")
  }
  for (const group of REQUIRED_GROUPS) {
    if (!theme[group] || typeof theme[group] !== "object" || Array.isArray(theme[group])) {
      errors.push(`${group} must be an object`)
    }
  }
  if (theme.base) {
    for (const key of ["bg", "fg", "muted", "border", "accent"]) {
      validateColor(theme.base[key], `base.${key}`, errors)
    }
  }
  if (theme.semantic) {
    for (const key of ["info", "warn", "error", "success"]) {
      validateColor(theme.semantic[key], `semantic.${key}`, errors)
    }
  }
  if (theme.components) {
    for (const key of ["panel", "header", "footer", "diff_add", "diff_del"]) {
      validateColor(theme.components[key], `components.${key}`, errors)
    }
  }
  if (theme.modes) {
    for (const key of MODE_KEYS) {
      validateColor(theme.modes[key], `modes.${key}`, errors)
    }
  }
  // 0.6.0 的三组是**可选**的：只在用户写了某个键时校验它的取值。
  // 加进必填列表会让所有已存在的主题文件突然不合法 —— 而 load-theme 对
  // 不合法主题是静默回落默认，用户只会看到「配色莫名其妙变了」。
  // markdown.text 允许 null（表示正文不着色）。
  for (const group of ["roles", "markdown", "overlay"]) {
    const section = theme[group]
    if (section === undefined) continue
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      errors.push(`${group} must be an object`)
      continue
    }
    for (const [key, value] of Object.entries(section)) {
      if (value === null) continue
      validateColor(value, `${group}.${key}`, errors)
    }
  }
  return { valid: errors.length === 0, errors }
}
