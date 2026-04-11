import { Command } from "commander"
import { buildContext, printContextWarnings } from "../context.mjs"
import { executeTurn, newSessionId, resolveMode, resolvePromptMode } from "../session/engine.mjs"
import { renderStatusBar } from "../theme/status-bar.mjs"
import { applyCommandTemplate, loadCustomCommands } from "../command/custom-commands.mjs"
import { ToolRegistry } from "../tool/registry.mjs"
import { SkillRegistry } from "../skill/registry.mjs"
import { PermissionEngine } from "../permission/engine.mjs"
import { HookBus, initHookBus } from "../plugin/hook-bus.mjs"
import { listProviders } from "../provider/router.mjs"

export function resolveChatExecutionMode(prompt, requestedMode) {
  return resolvePromptMode(prompt, requestedMode)
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

      const routedMode = resolveChatExecutionMode(chatParams.prompt ?? prompt, chatParams.mode ?? mode)
      const effectiveMode = routedMode.effectiveMode
      const effectiveExplanation = routedMode.route.explanation || routedMode.route.reason

      if (routedMode.route.changed) {
        console.log(`mode routed: ${routedMode.requestedMode} -> ${effectiveMode} (${effectiveExplanation})`)
      } else if (routedMode.route.forced && routedMode.route.suggestion) {
        console.log(`mode kept: ${effectiveMode} (${effectiveExplanation}; suggested ${routedMode.route.suggestion})`)
      } else if (routedMode.route.suggestion === "longagent" && routedMode.requestedMode === "agent") {
        console.log(`mode note: ${effectiveMode} (${effectiveExplanation}; consider --mode longagent)`)
      } else {
        console.log(`mode: ${effectiveMode} (${effectiveExplanation})`)
      }

      const result = await executeTurn({
        prompt: chatParams.prompt ?? prompt,
        mode: effectiveMode,
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
        mode: effectiveMode,
        model: result.model,
        permission: ctx.configState.config.permission.default_policy,
        tokenMeter: result.tokenMeter,
        aggregation: ctx.configState.config.usage.aggregation,
        cost: result.cost,
        showCost: ctx.configState.config.ui.status.show_cost,
        showTokenMeter: ctx.configState.config.ui.status.show_token_meter,
        theme: ctx.themeState.theme,
        layout: ctx.configState.config.ui.layout,
        longagentState: effectiveMode === "longagent" ? result.longagent : null
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
