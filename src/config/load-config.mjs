import path from "node:path"
import { access, readFile } from "node:fs/promises"
import YAML from "yaml"
import { DEFAULT_CONFIG } from "./defaults.mjs"
import { validateConfig } from "./schema.mjs"
import { projectConfigCandidates, userConfigCandidates } from "../storage/paths.mjs"

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

const ENV_VAR_RE = /^[A-Z][A-Z0-9_]{1,}$/

const ENV_VAR_SKIP_KEYS = new Set(["api_key_env"])

function resolveEnvVars(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (ENV_VAR_SKIP_KEYS.has(k)) {
      out[k] = v
    } else if (typeof v === "string" && ENV_VAR_RE.test(v)) {
      out[k] = process.env[v] !== undefined ? process.env[v] : v
    } else if (Array.isArray(v)) {
      out[k] = v.map(item =>
        typeof item === "string" && ENV_VAR_RE.test(item)
          ? (process.env[item] !== undefined ? process.env[item] : item)
          : item
      )
    } else if (v && typeof v === "object") {
      out[k] = resolveEnvVars(v)
    } else {
      out[k] = v
    }
  }
  return out
}

function resolveConfigEnvVars(config) {
  if (!config || typeof config !== "object") return config
  const out = { ...config }
  if (out.provider && typeof out.provider === "object") {
    const provider = { ...out.provider }
    for (const key of Object.keys(provider)) {
      if (key === "default" || key === "strict_mode" || key === "model_context") continue
      if (provider[key] && typeof provider[key] === "object") {
        provider[key] = resolveEnvVars(provider[key])
      }
    }
    out.provider = provider
  }
  return out
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

async function loadOne(filePath) {
  if (!filePath) return { config: {}, errors: [] }
  try {
    const raw = await readFile(filePath, "utf8")
    const parsed = parseConfigFile(filePath, raw) ?? {}
    const resolved = resolveConfigEnvVars(parsed)
    const check = validateConfig(resolved)
    if (check.valid) return { config: resolved, errors: [] }
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
  const merged = mergeObject(mergeObject(DEFAULT_CONFIG, userLoaded.config), projectLoaded.config)

  const source = {
    userPath,
    userDir: userPath ? path.dirname(userPath) : null,
    userRaw: userLoaded.config,
    projectPath,
    projectDir: projectPath ? path.dirname(projectPath) : null,
    projectRaw: projectLoaded.config
  }

  return {
    config: merged,
    source,
    errors: [...userLoaded.errors, ...projectLoaded.errors]
  }
}
