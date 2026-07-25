import { Command } from "commander"
import { buildContext, printContextWarnings, resolveExtensionPolicy } from "../context.mjs"
import { ensureEventSinks, executeTurn, formatPublicModeSummary, getPublicModeContract, newSessionId, resolvePromptMode, summarizeRouteDecision } from "../session/engine.mjs"
import { emitRouteDecisionEvent } from "../session/routing-observability.mjs"
import { renderStatusBar } from "../theme/status-bar.mjs"
import { applyCommandTemplate, loadCustomCommands } from "../command/custom-commands.mjs"
import { ToolRegistry } from "../tool/registry.mjs"
import { SkillRegistry } from "../skill/registry.mjs"
import { PermissionEngine } from "../permission/engine.mjs"
import { HookBus, initHookBus } from "../plugin/hook-bus.mjs"
import { listProviders } from "../provider/router.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { createOutputReporter, resolveOutputFormat } from "../cli/output-format.mjs"
import { MODE_IDS, DEFAULT_MODE_ID, modeIdFromLegacy, laneOf, approvalOf, getMode } from "../core/modes.mjs"
import { applyPermissionLevel } from "../repl/permission-flow.mjs"

export function resolveChatExecutionMode(prompt, requestedMode) {
  return resolvePromptMode(prompt, requestedMode)
}

export function createChatCommand() {
  const providers = listProviders()
  return new Command("chat")
    .description("run one prompt in plan/agent/agent-auto/ultra/yolo mode (agent = default lane)")
    .argument("<prompt...>", "prompt text")
    .option("--mode <mode>", `${MODE_IDS.join("|")} (legacy assistant|code|coding|longagent still accepted)`, "agent")
    .option("--yolo", "shorthand for --mode yolo: skip every approval prompt")
    .option("--model <model>", "model id")
    .option("--provider-type <type>", `provider type (${providers.join("|")})`)
    .option("--base-url <url>", "provider base url override")
    .option("--api-key-env <name>", "api key env override")
    .option("--output-format <format>", "text|json|stream-json|legacy")
    .option("--max-iterations <n>", "longagent max iterations (0 = unlimited)")
    .option("--session <id>", "session id")
    .action(async (promptParts, options) => {
      const outputFormat = resolveOutputFormat(options.outputFormat)
      const reporter = createOutputReporter(outputFormat)
      const ctx = await buildContext()
      printContextWarnings(ctx)
      PermissionEngine.setTrusted(ctx.trustState?.trusted !== false)
      const extensionPolicy = resolveExtensionPolicy(ctx.configState)
      await SkillRegistry.initialize(extensionPolicy.config, process.cwd(), {
        allowProjectSources: extensionPolicy.allowProjectSources
      })
      let prompt = promptParts.join(" ").trim()
      if (prompt.startsWith("$") || prompt.startsWith("/")) {
        const sigil = prompt.startsWith("$") ? "$" : "/"
        const [name, ...argTokens] = prompt.slice(1).split(/\s+/)
        const args = argTokens.join(" ").trim()
        const skill = SkillRegistry.get(name)
        if (sigil === "$" || skill) {
          if (!skill) throw new Error(`unknown skill: $${name}`)
          const expanded = await SkillRegistry.execute(name, args, {
            cwd: process.cwd(),
            mode: options.mode || "assistant",
            model: options.model || "",
            provider: options.providerType || "",
            config: ctx.configState.config
          })
          prompt = typeof expanded === "object" && expanded?.contextFork ? expanded.prompt || "" : String(expanded || "")
        } else {
          const commands = await loadCustomCommands(process.cwd(), {
            allowProjectSources: extensionPolicy.allowProjectSources
          })
          const custom = commands.find((item) => item.name === name)
          if (custom) {
            prompt = applyCommandTemplate(custom.template, args, {
              path: process.cwd()
            })
          }
        }
      }

      // --mode 接受 0.4.0 模式 id 与 0.3.x 旧名；模式同时决定航道与审批档
      const requestedModeId = options.yolo ? "yolo" : (modeIdFromLegacy(options.mode) || DEFAULT_MODE_ID)
      const mode = laneOf(requestedModeId)
      ctx.configState.config.permission = applyPermissionLevel(
        approvalOf(requestedModeId),
        ctx.configState.config.permission || {}
      )
      const providerType = options.providerType ?? ctx.configState.config.provider.default
      const providerDefaults = ctx.configState.config.provider[providerType]
      if (!providerDefaults) {
        throw new Error(`unknown provider type: ${providerType}`)
      }
      const model = options.model ?? providerDefaults.default_model
      const sessionId = options.session || newSessionId()

      await ToolRegistry.initialize({
        config: extensionPolicy.config,
        cwd: process.cwd(),
        allowProjectSources: extensionPolicy.allowProjectSources
      })

      await initHookBus(process.cwd(), extensionPolicy.config, {
        allowProjectSources: extensionPolicy.allowProjectSources
      })
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
      const requestedContract = getPublicModeContract(routedMode.requestedMode)
      const effectiveContract = routedMode.effectiveContract || getPublicModeContract(effectiveMode)
      ensureEventSinks()
      await emitRouteDecisionEvent({
        sessionId,
        source: "chat",
        requestedMode: routedMode.requestedMode,
        route: routedMode.route,
        prompt: chatParams.prompt ?? prompt
      })

      // 报告用户实际选择的模式，而不是它底下的航道：传 --mode agent-auto
      // 却看到 "mode: assistant" 只会让人以为参数没生效。
      const requestedMode = getMode(requestedModeId)
      const modeLabel = `${requestedMode.icon} ${requestedMode.label}`
      if (routedMode.route.changed) {
        reporter.progress(`mode routed: ${modeLabel} -> ${effectiveMode} (${effectiveExplanation})`)
      } else if (routedMode.route.forced && routedMode.route.suggestion) {
        reporter.progress(`mode kept: ${modeLabel} (${effectiveExplanation}; suggested ${routedMode.route.suggestion})`)
      } else if (routedMode.route.suggestion === "longagent" && requestedMode.lane === "assistant") {
        reporter.progress(`mode note: ${modeLabel} (${effectiveExplanation}; consider --mode ultra)`)
      } else {
        reporter.progress(`mode: ${modeLabel} (${effectiveExplanation})`)
      }
      reporter.progress(`approval: ${requestedMode.approval} · lane: ${effectiveMode}`)
      if (routedMode.requestedMode !== effectiveMode) {
        reporter.progress(`requested lane: ${requestedContract.summary}`)
      }
      reporter.progress(`effective lane: ${formatPublicModeSummary(effectiveMode)}`)
      reporter.progress(`lane guarantee: ${effectiveContract.guarantee}`)
      reporter.progress(`route summary: ${summarizeRouteDecision(routedMode.route)}`)

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
        output: ctx.configState.config.provider[chatParams.providerType ?? providerType]?.stream !== false &&
          (outputFormat === "legacy" || outputFormat === "stream-json")
          ? { write: (chunk) => reporter.delta(chunk) }
          : null
      })

      if (outputFormat !== "legacy") {
        for (const warning of result.pricingWarnings || []) reporter.warning(`pricing warning: ${warning}`)
        for (const warning of result.budgetWarnings || []) reporter.warning(`budget warning: ${warning}`)
        reporter.finish(result)
        return
      }

      const status = renderStatusBar({
        mode: effectiveMode,
        model: result.model,
        permission: ctx.configState.config.permission.level || ctx.configState.config.permission.mode || ctx.configState.config.permission.default_policy,
        tokenMeter: result.tokenMeter,
        aggregation: ctx.configState.config.usage.aggregation,
        cost: result.cost,
        showCost: ctx.configState.config.ui.status.show_cost,
        showTokenMeter: ctx.configState.config.ui.status.show_token_meter,
        theme: ctx.themeState.theme,
        layout: ctx.configState.config.ui.layout,
        // headless 此前从不传 contextMeter —— CLI 下看不到上下文占用
        contextMeter: result.context || null,
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
