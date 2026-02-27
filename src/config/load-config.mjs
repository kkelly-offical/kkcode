import path from "node:path"
import { access, readFile } from "node:fs/promises"
import YAML from "yaml"
import { DEFAULT_CONFIG } from "./defaults.mjs"
import { validateConfig } from "./schema.mjs"
import { projectConfigCandidates, userConfigCandidates, envFileCandidates } from "../storage/paths.mjs"

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

export async function loadConfig(cwd = process.cwd()) {
  const userPath = await firstExisting(userConfigCandidates())
  const projectPath = await firstExisting(projectConfigCandidates(cwd))

  const userLoaded = await loadOne(userPath)
  const projectLoaded = await loadOne(projectPath)
  let merged = mergeObject(mergeObject(DEFAULT_CONFIG, userLoaded.config), projectLoaded.config)

  // .env overlay — highest priority, KKCODE_ prefixed vars
  let envPath = null
  let envOverlay = {}
  const envCandidate = await firstExisting(envFileCandidates(cwd))
  if (envCandidate) {
    try {
      const raw = await readFile(envCandidate, "utf8")
      envOverlay = parseEnvOverlay(raw)
      if (Object.keys(envOverlay).length > 0) {
        envPath = envCandidate
        merged = mergeObject(merged, envOverlay)
      }
    } catch { /* ignore unreadable .env */ }
  }

  const source = {
    userPath,
    userDir: userPath ? path.dirname(userPath) : null,
    userRaw: userLoaded.config,
    projectPath,
    projectDir: projectPath ? path.dirname(projectPath) : null,
    projectRaw: projectLoaded.config,
    envPath,
    envOverlay
  }

  return {
    config: merged,
    source,
    errors: [...userLoaded.errors, ...projectLoaded.errors]
  }
}
