import { Command } from "commander"
import { initHookBus, HookBus } from "../plugin/hook-bus.mjs"
import { buildContext } from "../context.mjs"

export function createHookCommand() {
  const cmd = new Command("hook").description("inspect loaded hooks")

  cmd
    .command("list")
    .description("list loaded hooks and loading errors")
    .action(async () => {
      const ctx = await buildContext()
      await initHookBus(process.cwd(), ctx.configState.config)
      const hooks = HookBus.list()
      const errors = HookBus.errors()
      console.log(`supported events: ${HookBus.supportedEvents().join(", ")}`)
      if (!hooks.length) {
        console.log("no hooks loaded")
      } else {
        for (const hook of hooks) {
          console.log(`- ${hook.name} (${hook.source})`)
        }
      }
      if (errors.length) {
        console.log("hook loading errors:")
        for (const err of errors) console.log(`- ${err}`)
      }
    })

  return cmd
}
