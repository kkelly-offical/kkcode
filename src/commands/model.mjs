import { Command } from "commander"
import { loadConfig } from "../config/load-config.mjs"
import {
  discoverModelsForProvider,
  resolveProviderConnection,
  escapeTerminalText,
  validateModelId,
  requestProvider,
  resolveProviderProfile,
  resolveTaskModel,
  TASK_MODEL_ROLES
} from "../kernel/index.mjs"

function selectedProvider(configState, requested) {
  return requested || configState.config.provider?.default
}

function selectedModel(configState, providerName, requested) {
  return requested || configState.config.provider?.[providerName]?.default_model || ""
}

function printModelList(result) {
  const freshness = result.stale ? "stale cache" : result.source
  console.log(`${escapeTerminalText(result.provider)} (${escapeTerminalText(result.protocol)}, ${freshness})`)
  for (const model of result.models) console.log(escapeTerminalText(model.id))
  if (!result.models.length) console.log("(no models returned)")
  if (result.warning) console.error(`warning: ${result.warning}`)
}

export function createModelCommand() {
  const command = new Command("model").description("discover and test provider models")

  command.command('profile').description('只读检查模型能力来源、预算与渠道范围；不请求模型或刷新目录')
    .option('-p, --provider <name>', '已配置渠道名称')
    .option('-m, --model <id>', '模型 ID')
    .option('--json', '输出不含密钥或 URL 查询参数的结构化档案')
    .action(async options => {
      const state = await loadConfig(process.cwd()), provider = selectedProvider(state, options.provider)
      const profile = await resolveProviderProfile(state, provider, selectedModel(state, provider, options.model))
      if (options.json) console.log(JSON.stringify(profile, null, 2))
      else {
        console.log(`${escapeTerminalText(profile.provider)} / ${escapeTerminalText(profile.model)} — ${escapeTerminalText(profile.protocol)}`)
        console.log(`端点：${escapeTerminalText(profile.endpointOrigin)}；上下文：${profile.context.limit} (${profile.context.source})；输出预留：${profile.output.reserved}`)
        for (const [capability, evidence] of Object.entries(profile.capabilities)) console.log(`${capability}: ${evidence.value === null ? '未知' : evidence.value ? '支持/已启用' : '未支持/未启用'} (${evidence.source})`)
        console.log(profile.compatibility.note)
      }
    })
  command.command('route <role>').description(`只读解释职责模型路由：${TASK_MODEL_ROLES.join(', ')}`)
    .option('-p, --provider <name>', '当前会话渠道名称')
    .option('-m, --model <id>', '当前会话模型 ID')
    .option('--json', '输出结构化路由说明')
    .action(async (role, options) => {
      const state = await loadConfig(process.cwd()), provider = selectedProvider(state, options.provider)
      const route = await resolveTaskModel(state, { role, providerType: provider, model: selectedModel(state, provider, options.model) })
      const profile = await resolveProviderProfile(state, route.providerType, route.model)
      const report = { role, provider: route.providerType, model: route.model, source: route.source, overridden: route.overridden, protocol: profile.protocol, endpointOrigin: profile.endpointOrigin }
      if (options.json) console.log(JSON.stringify(report, null, 2))
      else console.log(`${escapeTerminalText(role)} → ${escapeTerminalText(report.provider)} / ${escapeTerminalText(report.model)} (${escapeTerminalText(report.source)})\n端点：${escapeTerminalText(report.endpointOrigin)}；此命令不会产生推理费用。`)
    })

  command
    .command("list")
    .description("read the model catalog from the configured provider Base URL")
    .option("-p, --provider <name>", "configured provider name (defaults to provider.default)")
    .option("--refresh", "bypass the fresh model cache", false)
    .option("--json", "print structured JSON", false)
    .action(async (options) => {
      const configState = await loadConfig(process.cwd())
      const providerName = selectedProvider(configState, options.provider)
      const result = await discoverModelsForProvider(configState, {
        providerName,
        refresh: options.refresh
      })
      if (options.json) {
        console.log(JSON.stringify({ schema: "kk.model-list.v1", ...result }, null, 2))
      } else {
        printModelList(result)
      }
    })

  command
    .command("test")
    .description("validate catalog access and optionally make a minimal inference request")
    .option("-p, --provider <name>", "configured provider name (defaults to provider.default)")
    .option("-m, --model <id>", "model id (defaults to provider.default_model)")
    .option("--probe", "make a minimal, potentially billable inference request", false)
    .option("--json", "print structured JSON", false)
    .action(async (options) => {
      const configState = await loadConfig(process.cwd())
      const providerName = selectedProvider(configState, options.provider)
      const model = validateModelId(selectedModel(configState, providerName, options.model))
      if (!model) throw new Error(`provider "${providerName}" has no default_model; pass --model`)
      const connection = resolveProviderConnection(configState, providerName)
      const catalog = await discoverModelsForProvider(configState, { providerName, refresh: true })
      if (catalog.stale) {
        throw new Error(`provider "${providerName}" could not refresh its model catalog: ${catalog.warning || "using stale cache"}`)
      }
      const catalogMatch = catalog.models.some((item) => item.id === model)
      if (!catalogMatch) {
        throw new Error(`model "${model}" was not returned by provider "${providerName}"`)
      }

      let probe = null
      if (options.probe) {
        const result = await requestProvider({
          configState,
          providerType: providerName,
          model,
          system: "",
          messages: [{ role: "user", content: "Reply with OK." }],
          tools: [],
          maxTokens: 1
        })
        probe = {
          ok: true,
          responseReceived: Boolean(result.text || result.reasoning || result.toolCalls?.length),
          usage: result.usage || null
        }
      }

      const report = {
        schema: "kk.model-test.v1",
        ok: true,
        provider: providerName,
        protocol: connection.protocol,
        model,
        catalog: {
          ok: true,
          source: catalog.source,
          stale: catalog.stale
        },
        probe
      }
      if (options.json) console.log(JSON.stringify(report, null, 2))
      else {
        console.log(`ok: ${providerName} / ${model}`)
        console.log(`protocol: ${connection.protocol}`)
        console.log(`catalog: ${catalog.source}${catalog.stale ? " (stale)" : ""}`)
        console.log(`probe: ${options.probe ? "ok" : "skipped (use --probe for a billable request)"}`)
      }
    })

  return command
}
