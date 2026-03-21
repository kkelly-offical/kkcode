import { join } from "node:path"
import { mkdir, writeFile, access } from "node:fs/promises"
import { createInterface } from "node:readline/promises"
import { Command } from "commander"
import YAML from "yaml"
import { DEFAULT_CONFIG } from "../config/defaults.mjs"
import { validateConfig } from "../config/schema.mjs"
import { buildProviderEntryFromCatalog, listCatalogProviders, getProviderSpec } from "../provider/catalog.mjs"
import { runProviderOnboarding } from "./auth.mjs"

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

function formatProviderGuide(providerId) {
  const spec = getProviderSpec(providerId)
  if (!spec) return providerId
  const authModes = Array.isArray(spec.auth_modes) && spec.auth_modes.length
    ? spec.auth_modes.join("/")
    : "api_key"
  const oauth = spec.supports_oauth ? ` oauth:${spec.oauth_flow || "browser"}` : ""
  const model = spec.default_model ? ` default:${spec.default_model}` : ""
  return `${spec.label} [${providerId}] (${authModes}${oauth}${model ? `,${model}` : ""})`
}

function printProviderCatalog() {
  console.log("providers:")
  for (const providerId of PROVIDER_ORDER) {
    const spec = getProviderSpec(providerId)
    if (!spec) continue
    console.log(`- ${spec.label} [${providerId}]`)
    console.log(`  auth: ${(spec.auth_modes || []).join(", ") || "api_key"}`)
    if (spec.supports_oauth) {
      console.log(`  oauth: ${spec.oauth_flow || "browser"}`)
    }
    if (spec.default_model) {
      console.log(`  default_model: ${spec.default_model}`)
    }
    if (spec.auth_docs_url) {
      console.log(`  docs: ${spec.auth_docs_url}`)
    }
  }
}

const SPECIAL_PROVIDER_KEYS = new Set(["default", "strict_mode", "model_context"])
const PROVIDER_DEFAULTS = Object.fromEntries(
  listCatalogProviders({ includeInInit: true }).map((provider) => [provider.id, buildProviderEntryFromCatalog(provider.id) || {}])
)

for (const [name, value] of Object.entries(DEFAULT_CONFIG.provider)) {
  if (SPECIAL_PROVIDER_KEYS.has(name) || !value || typeof value !== "object") continue
  PROVIDER_DEFAULTS[name] = {
    ...(PROVIDER_DEFAULTS[name] || {}),
    type: value.type || null,
    base_url: value.base_url || "",
    api_key_env: value.api_key_env || "",
    default_model: value.default_model || "",
    headers: value.headers || null
  }
}

if (!PROVIDER_DEFAULTS["openai-compatible"]) {
  PROVIDER_DEFAULTS["openai-compatible"] = {
    type: "openai-compatible",
    base_url: "",
    api_key_env: "",
    default_model: "",
    headers: null
  }
}

const PROVIDER_ORDER = listCatalogProviders({ includeInInit: true })
  .map((provider) => provider.id)
  .filter((name, index, list) => list.indexOf(name) === index && PROVIDER_DEFAULTS[name])

// Auto-detect available providers by checking environment variables
function detectProvider() {
  const checks = PROVIDER_ORDER
    .map((provider) => ({
      provider,
      env: PROVIDER_DEFAULTS[provider]?.api_key_env || ""
    }))
    .filter((item) => item.env)
  const available = []
  for (const { provider, env } of checks) {
    if (process.env[env]) available.push(provider)
  }
  // Keep a stable preference order rather than relying on object iteration.
  if (available.includes("openai")) return { provider: "openai", detected: available }
  if (available.includes("anthropic")) return { provider: "anthropic", detected: available }
  if (available.length) return { provider: available[0], detected: available }
  return { provider: "openai", detected: [] }
}

function buildConfig(answers) {
  const defaults = PROVIDER_DEFAULTS[answers.provider] || {}
  const config = {
    provider: {
      default: answers.provider
    },
    permission: {
      default_policy: answers.permissionPolicy || "ask"
    }
  }
  const block = {}
  if (defaults.type && defaults.type !== answers.provider) block.type = defaults.type
  if (answers.baseUrl || defaults.base_url) block.base_url = answers.baseUrl || defaults.base_url
  if (answers.apiKeyEnv || defaults.api_key_env) block.api_key_env = answers.apiKeyEnv || defaults.api_key_env
  if (answers.model || defaults.default_model) block.default_model = answers.model || defaults.default_model
  if (defaults.headers) block.headers = { ...defaults.headers }
  if (Object.keys(block).length) {
    config.provider[answers.provider] = block
  }
  return config
}

async function runInteractive(rl) {
  const providers = PROVIDER_ORDER.map((providerId) => formatProviderGuide(providerId))
  const { provider: detectedProvider, detected } = detectProvider()
  if (detected.length) {
    console.log(`\nauto-detected API keys: ${detected.join(", ")}`)
  }
  const detectedChoice = formatProviderGuide(detectedProvider)
  const providerChoice = await askChoice(rl, "select default provider:", providers, detectedChoice)
  const provider = PROVIDER_ORDER[providers.indexOf(providerChoice)] || detectedProvider
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
    .option("--providers", "print available providers and exit")
    .option("--onboard-auth", "run provider auth onboarding after config creation")
    .action(async (options) => {
      if (options.providers) {
        printProviderCatalog()
        return
      }
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
      const providerSpec = getProviderSpec(defaultProvider)
      if (providerSpec?.supports_oauth) {
        console.log(`next: kkcode auth login ${defaultProvider}`)
      } else if (providerCfg.api_key_env) {
        console.log(`next: export ${providerCfg.api_key_env}=...`)
      }
      if (providerSpec?.auth_docs_url) {
        console.log(`docs: ${providerSpec.auth_docs_url}`)
      }
      if (options.onboardAuth) {
        const onboarding = await runProviderOnboarding({
          providerId: defaultProvider,
          cwd,
          login: true,
          setDefault: true,
          loginOptions: {}
        })
        console.log(`onboard: ${onboarding.ready ? "ready" : "not-ready"}`)
        if (onboarding.login?.kind === "profile") {
          if (onboarding.login.openUrl) console.log(`open: ${onboarding.login.openUrl}`)
          if (onboarding.login.userCode) console.log(`code: ${onboarding.login.userCode}`)
          console.log(`profile: ${onboarding.login.profileId}`)
        }
        if (onboarding.login?.kind === "error") {
          console.log(`login_error: ${onboarding.login.message}`)
        }
        if (onboarding.login?.kind === "pending_oauth") {
          console.log(`open: ${onboarding.login.authUrl}`)
          console.log(`redirect_uri: ${onboarding.login.redirectUri}`)
          for (const step of onboarding.nextSteps) console.log(`next: ${step}`)
        }
      }
      console.log("run 'kkcode doctor' for full diagnostics")
    })
}
