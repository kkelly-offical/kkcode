import path from "node:path"
import { access, readFile } from "node:fs/promises"
import YAML from "yaml"
import { DEFAULT_CONFIG } from "./defaults.mjs"
import { validateConfig } from "./schema.mjs"
import { projectConfigCandidates, userConfigCandidates, envFileCandidates, userRootDir } from "../storage/paths.mjs"
import { noteDeprecation } from "../core/deprecations.mjs"

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function parseConfigFile(filePath, content) {
  if (filePath.endsWith(".json")) return JSON.parse(content)
  return YAML.parse(content)
}

function mergeObject(base, override) {
  if (override === undefined || override === null) return base
  if (Array.isArray(override)) return [...override]
  if (!base || typeof base !== "object" || Array.isArray(base)) return override
  if (typeof override !== "object") return override
  const out = { ...base }
  for (const key of Object.keys(override)) {
    out[key] = mergeObject(base[key], override[key])
  }
  return out
}

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  return null
}

/**
 * Parse .env file — only extract KKCODE_ prefixed vars into nested config.
 * Uses __ (double underscore) as nesting separator, single _ stays in key name.
 *
 * KKCODE_PROVIDER__DEFAULT=anthropic → { provider: { default: "anthropic" } }
 * KKCODE_AGENT__LONGAGENT__PARALLEL__MAX_CONCURRENCY=5 → { agent: { longagent: { parallel: { max_concurrency: 5 } } } }
 * KKCODE_LANGUAGE=zh → { language: "zh" }
 */
export function parseEnvOverlay(content) {
  const config = {}
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eqIdx = trimmed.indexOf("=")
    if (eqIdx <= 0) continue
    const key = trimmed.slice(0, eqIdx).trim()
    if (!key.startsWith("KKCODE_")) continue
    let val = trimmed.slice(eqIdx + 1).trim()
    // strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    // split on __ for nesting, lowercase each part
    const parts = key.slice(7).split("__").map(p => p.toLowerCase())
    // coerce types
    let typed = val
    if (val === "true") typed = true
    else if (val === "false") typed = false
    else if (val !== "" && !isNaN(val)) typed = Number(val)

    let cursor = config
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cursor[parts[i]] || typeof cursor[parts[i]] !== "object") cursor[parts[i]] = {}
      cursor = cursor[parts[i]]
    }
    cursor[parts[parts.length - 1]] = typed
  }
  return config
}

async function loadOne(filePath) {
  if (!filePath) return { config: {}, errors: [] }
  try {
    const raw = await readFile(filePath, "utf8")
    const parsed = parseConfigFile(filePath, raw) ?? {}
    const check = validateConfig(parsed)
    if (check.valid) return { config: parsed, errors: [] }
    return { config: {}, errors: check.errors.map((error) => `${filePath}: ${error}`) }
  } catch (error) {
    return { config: {}, errors: [`${filePath}: ${error.message}`] }
  }
}

/**
 * goal 模式的配置段键名（`agent.longagent.ultra.*`）。
 * 与 longagent 顶层键无一重名 —— 顶层出现这些键必然是写错了层级。
 */
const ULTRA_SECTION_KEYS = Object.freeze([
  "goal_mode", "max_rounds", "deadline_ms", "no_progress_rounds", "no_progress_warn_rounds",
  "on_blocked_non_tty", "confirm_acceptance", "stage_failure", "criteria", "report", "ledger"
])

/**
 * 把写在 longagent 顶层的 goal 模式键搬进 `.ultra` 段。
 *
 * 「Ultra 的配置」直觉上就该写在 `agent.ultra` 下，但 `agent.ultra` 是
 * 0.4.0 给 `agent.longagent` 起的别名，平铺后 `agent.ultra.goal_mode`
 * 落到没人读的 `agent.longagent.goal_mode` —— 校验通过、静默失效，
 * 只有反直觉的 `agent.ultra.ultra.goal_mode` 才真正生效（0.5.5 修复）。
 * 已经写对位置的值优先，不被顶层的错位值覆盖。
 */
function hoistUltraSectionKeys(longagent) {
  const misplaced = ULTRA_SECTION_KEYS.filter((key) => longagent[key] !== undefined)
  if (misplaced.length === 0) return longagent

  const next = { ...longagent, ultra: { ...(longagent.ultra || {}) } }
  for (const key of misplaced) {
    if (next.ultra[key] === undefined) next.ultra[key] = next[key]
    delete next[key]
  }
  noteDeprecation(
    "config.agent.ultra.section",
    `${misplaced.map((k) => `agent.ultra.${k}`).join("、")} 应写在 agent.ultra.ultra.${misplaced[0]} 段下；` +
    "已自动归位，下一个大版本会移除这层兼容"
  )
  return next
}

/**
 * 把 0.4.0 的 `agent.ultra` 归一到内部仍在使用的 `agent.longagent`。
 * 两个键同时存在时 ultra 优先——它是新写法。
 */
function normalizeUltraKey(raw) {
  if (!raw?.agent) return raw
  const { ultra, ...agentRest } = raw.agent
  const longagent = ultra ? mergeObject(agentRest.longagent || {}, ultra) : agentRest.longagent
  if (!longagent) return raw
  return { ...raw, agent: { ...agentRest, longagent: hoistUltraSectionKeys(longagent) } }
}

export async function loadConfig(cwd = process.cwd()) {
  const resolvedCwd = path.resolve(cwd)
  const userPath = await firstExisting(userConfigCandidates())
  const projectPath = await firstExisting(projectConfigCandidates(cwd))

  const userLoaded = await loadOne(userPath)
  const projectLoaded = await loadOne(projectPath)
  let userConfig = mergeObject(DEFAULT_CONFIG, normalizeUltraKey(userLoaded.config))
  let merged = mergeObject(userConfig, normalizeUltraKey(projectLoaded.config))

  // .env overlay — highest priority, KKCODE_ prefixed vars
  let envPath = null
  let envScope = null
  let envOverlay = {}
  const envCandidate = await firstExisting(envFileCandidates(cwd))
  if (envCandidate) {
    try {
      const raw = await readFile(envCandidate, "utf8")
      envOverlay = parseEnvOverlay(raw)
      if (Object.keys(envOverlay).length > 0) {
        envPath = envCandidate
        envScope = path.resolve(envCandidate) === path.resolve(userRootDir(), ".env")
          ? "user"
          : "project"
        if (envScope === "user") userConfig = mergeObject(userConfig, envOverlay)
        merged = mergeObject(merged, envOverlay)
      }
    } catch { /* ignore unreadable .env */ }
  }

  const source = {
    cwd: resolvedCwd,
    userPath,
    userDir: userPath ? path.dirname(userPath) : null,
    userRaw: userLoaded.config,
    projectPath,
    projectDir: projectPath ? path.dirname(projectPath) : null,
    projectRaw: projectLoaded.config,
    envPath,
    envScope,
    envOverlay
  }

  return {
    config: merged,
    userConfig,
    source,
    errors: [...userLoaded.errors, ...projectLoaded.errors]
  }
}
