const REQUIRED_GROUPS = ["base", "semantic", "modes", "components"]
const MODE_KEYS = ["ask", "plan", "agent", "longagent"]
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
  return { valid: errors.length === 0, errors }
}
