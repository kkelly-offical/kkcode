import path from "node:path"
import { access, readFile } from "node:fs/promises"
import YAML from "yaml"
import { DEFAULT_THEME } from "./default-theme.mjs"
import { validateTheme } from "./schema.mjs"

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function parseTheme(file, raw) {
  if (file.endsWith(".json")) return JSON.parse(raw)
  return YAML.parse(raw)
}

function deepMerge(base, override) {
  if (override === null || override === undefined) return base
  if (Array.isArray(override)) return [...override]
  if (typeof override !== "object") return override
  if (!base || typeof base !== "object" || Array.isArray(base)) return override
  const out = { ...base }
  for (const key of Object.keys(override)) {
    out[key] = deepMerge(base[key], override[key])
  }
  return out
}

function resolveConfiguredThemePath(configState) {
  const projectTheme = configState.source.projectRaw?.ui?.theme_file
  if (typeof projectTheme === "string" && projectTheme.trim()) {
    return path.resolve(configState.source.projectDir ?? process.cwd(), projectTheme)
  }
  const userTheme = configState.source.userRaw?.ui?.theme_file
  if (typeof userTheme === "string" && userTheme.trim()) {
    return path.resolve(configState.source.userDir ?? process.cwd(), userTheme)
  }
  return null
}

export async function loadTheme(configState, fileOverride = null) {
  const target = fileOverride ? path.resolve(fileOverride) : resolveConfiguredThemePath(configState)
  if (!target || !(await exists(target))) {
    return { theme: deepMerge(DEFAULT_THEME, { modes: configState.config.ui.mode_colors }), source: "default", errors: [] }
  }
  try {
    const raw = await readFile(target, "utf8")
    const parsed = parseTheme(target, raw)
    const merged = deepMerge(DEFAULT_THEME, parsed)
    merged.modes = deepMerge(merged.modes, configState.config.ui.mode_colors)
    const check = validateTheme(merged)
    if (!check.valid) {
      return {
        theme: deepMerge(DEFAULT_THEME, { modes: configState.config.ui.mode_colors }),
        source: "default",
        errors: check.errors.map((error) => `${target}: ${error}`)
      }
    }
    return { theme: merged, source: target, errors: [] }
  } catch (error) {
    return {
      theme: deepMerge(DEFAULT_THEME, { modes: configState.config.ui.mode_colors }),
      source: "default",
      errors: [`${target}: ${error.message}`]
    }
  }
}
