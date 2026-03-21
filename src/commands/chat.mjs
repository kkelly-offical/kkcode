import { Command } from "commander"
import { buildContext, printContextWarnings } from "../context.mjs"
import { executeTurn, newSessionId, resolveMode } from "../session/engine.mjs"
import { renderStatusBar } from "../theme/status-bar.mjs"
import { applyCommandTemplate, loadCustomCommands } from "../command/custom-commands.mjs"
import { ToolRegistry } from "../tool/registry.mjs"
import { SkillRegistry } from "../skill/registry.mjs"
import { PermissionEngine } from "../permission/engine.mjs"
import { HookBus, initHookBus } from "../plugin/hook-bus.mjs"
import { listProviders } from "../provider/router.mjs"
import { resolveProviderAuthProfile } from "../provider/auth-profiles.mjs"

function providerNeedsCredential(providerDefaults = {}, providerType = "") {
  const resolvedType = String(providerDefaults?.type || providerType || "").toLowerCase()
  return resolvedType !== "ollama"
}

export async function hasProviderCredential(providerType, providerDefaults = {}, apiKeyEnvOverride = null) {
  if (providerDefaults.api_key) return true
  const envName = apiKeyEnvOverride || providerDefaults.api_key_env || ""
  if (envName && process.env[envName]) return true
  const auth = await resolveProviderAuthProfile({
    providerId: providerType,
    explicitProfileId: providerDefaults.auth_profile || null
  })
  return auth.readyState === "ready"
}

function parseFallbackTarget(rawValue, defaultProviderType) {
  const raw = String(rawValue || "").trim()
  if (!raw) return null
  const split = raw.split("::", 2)
  if (split.length === 2 && split[0].trim() && split[1].trim()) {
    return { providerType: split[0].trim() }
  }
  return { providerType: defaultProviderType }
}

export async function hasAnyProviderCredential(config, providerType, providerDefaults = {}, apiKeyEnvOverride = null) {
  const candidates = [{ providerType, defaults: providerDefaults, apiKeyEnvOverride }]
  for (const rawFallback of Array.isArray(providerDefaults.fallback_models) ? providerDefaults.fallback_models : []) {
    const parsed = parseFallbackTarget(rawFallback, providerType)
    if (!parsed) continue
    const fallbackDefaults = config.provider?.[parsed.providerType] || {}
    candidates.push({ providerType: parsed.providerType, defaults: fallbackDefaults, apiKeyEnvOverride: null })
  }

  const seen = new Set()
  for (const candidate of candidates) {
    if (seen.has(candidate.providerType)) continue
    seen.add(candidate.providerType)
    if (!providerNeedsCredential(candidate.defaults, candidate.providerType)) return true
    if (await hasProviderCredential(candidate.providerType, candidate.defaults, candidate.apiKeyEnvOverride)) {
      return true
    }
  }
  return false
}

export function createChatCommand() {
  const providers = listProviders()
  return new Command("chat")
    .description("run one prompt in ask/plan/agent/longagent mode")
    .argument("<prompt...>", "prompt text")
    .option("--mode <mode>", "ask|plan|agent|longagent", "agent")
    .option("--model <model>", "model id")
    .option("--provider-type <type>", `provider type (${providers.join("|")})`)
    .option("--base-url <url>", "provider base url override")
    .option("--api-key-env <name>", "api key env override")
    .option("--max-iterations <n>", "longagent max iterations (0 = unlimited)")
    .option("--session <id>", "session id")
    .action(async (promptParts, options) => {
      const ctx = await buildContext()
      printContextWarnings(ctx)
      PermissionEngine.setTrusted(ctx.trustState?.trusted !== false)
      let prompt = promptParts.join(" ").trim()
      if (prompt.startsWith("/")) {
        const commands = await loadCustomCommands(process.cwd())
        const [name, ...argTokens] = prompt.slice(1).split(/\s+/)
        const custom = commands.find((item) => item.name === name)
        if (custom) {
          const args = argTokens.join(" ").trim()
          prompt = applyCommandTemplate(custom.template, args, {
            path: process.cwd()
          })
        }
      }

      const mode = resolveMode(options.mode)
      const providerType = options.providerType ?? ctx.configState.config.provider.default
      const providerDefaults = ctx.configState.config.provider[providerType]
      if (!providerDefaults) {
        throw new Error(`unknown provider type: ${providerType}`)
      }
      if (providerNeedsCredential(providerDefaults, providerType) && !await hasAnyProviderCredential(ctx.configState.config, providerType, providerDefaults, options.apiKeyEnv ?? null)) {
        const envName = options.apiKeyEnv ?? providerDefaults.api_key_env ?? "UNKNOWN_API_KEY_ENV"
        throw new Error(`missing API key for provider "${providerType}" (env: ${envName})`)
      }
      const model = options.model ?? providerDefaults.default_model
      const sessionId = options.session || newSessionId()

      await ToolRegistry.initialize({
        config: ctx.configState.config,
        cwd: process.cwd()
      })
      await SkillRegistry.initialize(ctx.configState.config, process.cwd())

      await initHookBus()
      const chatParams = await HookBus.chatParams({
        prompt,
        mode,
        model,
        providerType,
        sessionId,
        baseUrl: options.baseUrl ?? null,
        apiKeyEnv: options.apiKeyEnv ?? null
      })

      const result = await executeTurn({
        prompt: chatParams.prompt ?? prompt,
        mode: chatParams.mode ?? mode,
        model: chatParams.model ?? model,
        sessionId,
        configState: ctx.configState,
        providerType: chatParams.providerType ?? providerType,
        baseUrl: chatParams.baseUrl ?? options.baseUrl ?? null,
        apiKeyEnv: chatParams.apiKeyEnv ?? options.apiKeyEnv ?? null,
        maxIterations: options.maxIterations !== undefined ? Number(options.maxIterations) : null,
        output: ctx.configState.config.provider[chatParams.providerType ?? providerType]?.stream !== false
          ? { write: (chunk) => process.stdout.write(String(chunk || "")) }
          : null
      })

      const status = renderStatusBar({
        mode,
        model: result.model,
        permission: ctx.configState.config.permission.default_policy,
        tokenMeter: result.tokenMeter,
        aggregation: ctx.configState.config.usage.aggregation,
        cost: result.cost,
        showCost: ctx.configState.config.ui.status.show_cost,
        showTokenMeter: ctx.configState.config.ui.status.show_token_meter,
        theme: ctx.themeState.theme,
        layout: ctx.configState.config.ui.layout,
        longagentState: mode === "longagent" ? result.longagent : null
      })

      console.log(status)
      console.log("")
      const streamEnabled = ctx.configState.config.provider[chatParams.providerType ?? providerType]?.stream !== false
      if (!streamEnabled || !result.emittedText) {
        console.log(result.reply)
      }
      console.log("")
      if (result.toolEvents.length) {
        console.log(`tool events: ${result.toolEvents.length}`)
      }
      if (result.pricingWarnings.length) {
        for (const warning of result.pricingWarnings) {
          console.log(`pricing warning: ${warning}`)
        }
      }
      if (result.budgetWarnings.length) {
        for (const warning of result.budgetWarnings) {
          console.log(`budget warning: ${warning}`)
        }
      }
      console.log(`session: ${sessionId}`)
    })
}
