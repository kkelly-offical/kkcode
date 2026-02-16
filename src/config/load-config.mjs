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
