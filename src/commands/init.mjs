import { join } from "node:path"
import { mkdir, writeFile, access } from "node:fs/promises"
import { createInterface } from "node:readline/promises"
import { Command } from "commander"
import YAML from "yaml"
import { listProviders } from "../provider/router.mjs"
import { validateConfig } from "../config/schema.mjs"

async function exists(target) {
  try { await access(target); return true } catch { return false }
}

async function askQuestion(rl, question, defaultValue = "") {
  const suffix = defaultValue ? ` (${defaultValue})` : ""
  const answer = await rl.question(`${question}${suffix}: `)
  return answer.trim() || defaultValue
}

async function askChoice(rl, question, choices, defaultValue) {
  const choiceStr = choices.map((c, i) => `${i + 1}. ${c}`).join("\n")
  console.log(`\n${question}\n${choiceStr}`)
  const answer = await rl.question(`choose [${defaultValue}]: `)
  const trimmed = answer.trim()
  if (!trimmed) return defaultValue
  const idx = parseInt(trimmed, 10)
  if (idx >= 1 && idx <= choices.length) return choices[idx - 1]
  if (choices.includes(trimmed)) return trimmed
  return defaultValue
}

const PROVIDER_DEFAULTS = {
  openai: { api_key_env: "OPENAI_API_KEY", default_model: "gpt-5.3-codex" },
  anthropic: { api_key_env: "ANTHROPIC_API_KEY", default_model: "claude-opus-4-6" },
  ollama: { base_url: "http://localhost:11434", api_key_env: "", default_model: "llama3.1" },
  "openai-compatible": { base_url: "", api_key_env: "", default_model: "" }
}

// Auto-detect available providers by checking environment variables
function detectProvider() {
  const registered = new Set(listProviders())
  const checks = [
    { provider: "anthropic", env: "ANTHROPIC_API_KEY" },
    { provider: "openai", env: "OPENAI_API_KEY" }
  ]
  const available = []
  for (const { provider, env } of checks) {
    if (process.env[env] && registered.has(provider)) available.push(provider)
  }
  // Prefer anthropic if both are set, otherwise first available, fallback to openai
  if (available.includes("anthropic")) return { provider: "anthropic", detected: available }
  if (available.length) return { provider: available[0], detected: available }
  return { provider: "openai", detected: [] }
}

function buildConfig(answers) {
  const config = {
    provider: {
      default: answers.provider
    },
    permission: {
      default_policy: answers.permissionPolicy || "ask"
    }
  }
  const block = {}
  if (answers.baseUrl) block.base_url = answers.baseUrl
  if (answers.apiKeyEnv) block.api_key_env = answers.apiKeyEnv
  if (answers.model) block.default_model = answers.model
  if (Object.keys(block).length) {
    config.provider[answers.provider] = block
  }
  return config
}

async function runInteractive(rl) {
  const providers = listProviders()
  const { provider: detectedProvider, detected } = detectProvider()
  if (detected.length) {
    console.log(`\nauto-detected API keys: ${detected.join(", ")}`)
  }
  const provider = await askChoice(rl, "select default provider:", providers, detectedProvider)
  const defaults = PROVIDER_DEFAULTS[provider] || {}

  let baseUrl = ""
  let apiKeyEnv = ""
  let model = ""

  if (provider === "ollama") {
    baseUrl = await askQuestion(rl, "ollama base URL", defaults.base_url)
    model = await askQuestion(rl, "default model", defaults.default_model)
  } else if (provider === "openai-compatible") {
    baseUrl = await askQuestion(rl, "base URL", "")
    apiKeyEnv = await askQuestion(rl, "API key env var", "")
    model = await askQuestion(rl, "default model", "")
  } else {
    apiKeyEnv = await askQuestion(rl, "API key env var", defaults.api_key_env)
    model = await askQuestion(rl, "default model", defaults.default_model)
  }

  const permissionPolicy = await askChoice(
    rl,
    "default permission policy:",
    ["allow", "ask", "deny"],
    "ask"
  )

  return { provider, baseUrl, apiKeyEnv, model, permissionPolicy }
}

export function createInitCommand() {
  return new Command("init")
    .description("initialize kkcode in current project")
    .option("-y, --yes", "use defaults without prompting")
    .action(async (options) => {
      const cwd = process.cwd()
      const configDir = join(cwd, ".kkcode")
      const configFile = join(configDir, "config.yaml")

      if (await exists(configFile)) {
        console.log(`config already exists: ${configFile}`)
        console.log("use 'kkcode config' to modify it")
        return
      }

      let answers
      if (options.yes) {
        const { provider, detected } = detectProvider()
        const defaults = PROVIDER_DEFAULTS[provider] || {}
        if (detected.length) {
          console.log(`auto-detected: ${detected.join(", ")} → using ${provider}`)
        }
        answers = {
          provider,
          baseUrl: defaults.base_url || "",
          apiKeyEnv: defaults.api_key_env || "",
          model: defaults.default_model || "",
          permissionPolicy: "ask"
        }
      } else {
        const rl = createInterface({ input: process.stdin, output: process.stdout })
        try {
          answers = await runInteractive(rl)
        } finally {
          rl.close()
        }
      }

      const config = buildConfig(answers)
      const check = validateConfig(config)
      if (!check.valid) {
        console.error("generated config is invalid:")
        for (const e of check.errors) console.error(`  - ${e}`)
        process.exitCode = 1
        return
      }

      await mkdir(configDir, { recursive: true })
      await writeFile(configFile, YAML.stringify(config), "utf8")
      console.log(`created: ${configFile}`)

      const defaultProvider = config.provider.default
      const providerCfg = config.provider[defaultProvider] || {}
      if (providerCfg.api_key_env && !process.env[providerCfg.api_key_env]) {
        console.log(`note: environment variable ${providerCfg.api_key_env} is not set`)
      }
      console.log("run 'kkcode doctor' for full diagnostics")
    })
}
