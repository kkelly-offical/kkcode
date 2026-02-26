import path from "node:path"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { Command } from "commander"
import YAML from "yaml"
import { importConfig } from "../config/import-config.mjs"
import { validateConfig } from "../config/schema.mjs"
import { loadConfig } from "../config/load-config.mjs"
import { DEFAULT_CONFIG } from "../config/defaults.mjs"
import { projectConfigCandidates } from "../storage/paths.mjs"

function parseInput(file, raw) {
  if (file.endsWith(".json")) return JSON.parse(raw)
  return YAML.parse(raw)
}

function stringifyOutput(file, data) {
  if (file.endsWith(".json")) return JSON.stringify(data, null, 2) + "\n"
  return YAML.stringify(data)
}

function getByPath(obj, keyPath) {
  const keys = keyPath.split(".")
  let current = obj
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined
    current = current[key]
  }
  return current
}

function setByPath(obj, keyPath, value) {
  const keys = keyPath.split(".")
  let current = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]
    if (current[key] == null || typeof current[key] !== "object") {
      current[key] = {}
    }
    current = current[key]
  }
  current[keys[keys.length - 1]] = value
}

function coerceValue(raw) {
  if (raw === "true") return true
  if (raw === "false") return false
  if (raw === "null") return null
  const num = Number(raw)
  if (raw !== "" && Number.isFinite(num)) return num
  return raw
}

function isNonDefault(merged, defaults, keyPath) {
  const mergedVal = getByPath(merged, keyPath)
  const defaultVal = getByPath(defaults, keyPath)
  return JSON.stringify(mergedVal) !== JSON.stringify(defaultVal)
}

function printTree(obj, defaults, prefix = "", indent = "") {
  if (obj == null || typeof obj !== "object") {
    const marker = isNonDefault(obj, defaults, prefix) ? " *" : ""
    console.log(`${indent}${formatValue(obj)}${marker}`)
    return
  }
  for (const [key, value] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
      console.log(`${indent}${key}:`)
      printTree(value, defaults, fullPath, indent + "  ")
    } else {
      const marker = isNonDefault(value, getByPath(defaults, fullPath), "") ? " *" : ""
      console.log(`${indent}${key}: ${formatValue(value)}${marker}`)
    }
  }
}

function formatValue(v) {
  if (v === null) return "null"
  if (Array.isArray(v)) return JSON.stringify(v)
  return String(v)
}

export function createConfigCommand() {
  const cmd = new Command("config").description("manage kkcode config")

  cmd
    .command("import")
    .description("import external config into kkcode format")
    .requiredOption("--from <file>", "source config file path")
    .option("--to <file>", "output file path", "kkcode.config.yaml")
    .action(async (options) => {
      const from = path.resolve(options.from)
      const to = path.resolve(options.to)
      const raw = await readFile(from, "utf8")
      const parsed = parseInput(from, raw)
      const imported = importConfig(parsed)
      const check = validateConfig(imported)
      if (!check.valid) {
        console.error("import produced invalid config:")
        for (const error of check.errors) console.error(`- ${error}`)
        process.exitCode = 1
        return
      }
      await writeFile(to, stringifyOutput(to, imported), "utf8")
      console.log(`imported config written: ${to}`)
    })

  cmd
    .command("show")
    .description("show current effective config (merged)")
    .option("--section <name>", "show only a specific top-level section")
    .action(async (options) => {
      const { config, source } = await loadConfig(process.cwd())
      console.log("# effective config (user + project + defaults)")
      if (source.userPath) console.log(`# user:    ${source.userPath}`)
      if (source.projectPath) console.log(`# project: ${source.projectPath}`)
      console.log("# entries marked with * differ from defaults\n")
      const target = options.section ? { [options.section]: config[options.section] } : config
      if (options.section && config[options.section] === undefined) {
        console.error(`unknown section: ${options.section}`)
        process.exitCode = 1
        return
      }
      printTree(target, DEFAULT_CONFIG)
    })

  cmd
    .command("get <key>")
    .description("get a config value by dot-path (e.g. provider.default)")
    .action(async (key) => {
      const { config } = await loadConfig(process.cwd())
      const value = getByPath(config, key)
      if (value === undefined) {
        console.error(`key not found: ${key}`)
        process.exitCode = 1
        return
      }
      if (value != null && typeof value === "object") {
        console.log(YAML.stringify(value).trimEnd())
      } else {
        console.log(formatValue(value))
      }
    })

  cmd
    .command("set <key> <value>")
    .description("set a config value in project config (e.g. provider.default anthropic)")
    .action(async (key, rawValue) => {
      const cwd = process.cwd()
      const candidates = projectConfigCandidates(cwd)
      let configPath = null
      for (const c of candidates) {
        try {
          await readFile(c, "utf8")
          configPath = c
          break
        } catch { /* not found */ }
      }
      if (!configPath) {
        configPath = candidates[0]
        await mkdir(path.dirname(configPath), { recursive: true })
      }

      let existing = {}
      try {
        const raw = await readFile(configPath, "utf8")
        existing = parseInput(configPath, raw) || {}
      } catch { /* new file */ }

      const value = coerceValue(rawValue)
      setByPath(existing, key, value)

      const check = validateConfig(existing)
      if (!check.valid) {
        console.error("resulting config is invalid:")
        for (const e of check.errors) console.error(`  - ${e}`)
        process.exitCode = 1
        return
      }

      await writeFile(configPath, stringifyOutput(configPath, existing), "utf8")
      console.log(`${key} = ${formatValue(value)}`)
      console.log(`written: ${configPath}`)
    })

  return cmd
}
