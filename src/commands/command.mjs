import { Command } from "commander"
import { applyCommandTemplate, loadCustomCommands } from "../command/custom-commands.mjs"
import { buildContext, resolveExtensionPolicy } from "../context.mjs"

async function commandsForWorkspace() {
  const ctx = await buildContext()
  const extensionPolicy = resolveExtensionPolicy(ctx.configState)
  return loadCustomCommands(process.cwd(), {
    allowProjectSources: extensionPolicy.allowProjectSources
  })
}

export function createCommandCommand() {
  const cmd = new Command("command").description("inspect custom slash commands")

  cmd
    .command("list")
    .description("list discovered custom commands")
    .action(async () => {
      const list = await commandsForWorkspace()
      if (!list.length) {
        console.log("no custom commands found")
        return
      }
      for (const item of list) {
        console.log(`/${item.name} (${item.scope}) -> ${item.source}`)
      }
    })

  cmd
    .command("preview")
    .description("preview command template expansion")
    .requiredOption("--name <name>", "command name")
    .option("--args <text>", "arguments text", "")
    .action(async (options) => {
      const list = await commandsForWorkspace()
      const item = list.find((cmd) => cmd.name === options.name)
      if (!item) {
        console.error(`command not found: ${options.name}`)
        process.exitCode = 1
        return
      }
      const expanded = applyCommandTemplate(item.template, options.args, {
        path: process.cwd()
      })
      console.log(expanded)
    })

  return cmd
}
