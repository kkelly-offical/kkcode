import { Command } from "commander"
import { loadConfig } from "../config/load-config.mjs"
import { discoverModelsForProvider, resolveProviderConnection } from "../provider/model-catalog.mjs"
import { escapeTerminalText, validateModelId } from "../provider/model-id.mjs"
import { requestProvider } from "../provider/router.mjs"

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
