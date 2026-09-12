import { Command } from "commander"
import { createKernel } from "../kernel/index.mjs"

export function createHookCommand() {
  const cmd = new Command("hook").description("inspect loaded hooks")

  cmd
    .command("list")
    .description("list loaded hooks and loading errors")
    .action(async () => {
      // boot:false —— hook 巡检只初始化 hooks 这一个注册表
      const kernel = await createKernel({ cwd: process.cwd(), boot: false })
      const extensionPolicy = kernel.extensionPolicy
      const hooks = kernel.extensions.hooks
      await hooks.initialize(process.cwd(), extensionPolicy.config, {
        allowProjectSources: extensionPolicy.allowProjectSources
      })
      const loaded = hooks.list()
      const errors = hooks.errors()
      console.log(`supported events: ${hooks.supportedEvents().join(", ")}`)
      if (!loaded.length) {
        console.log("no hooks loaded")
      } else {
        for (const hook of loaded) {
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
