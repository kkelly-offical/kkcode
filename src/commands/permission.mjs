import { Command } from "commander"
import { printContextWarnings } from "../context.mjs"
import { createKernel } from "../kernel/index.mjs"
import { loadTheme } from "../theme/load-theme.mjs"
import { PermissionEngine } from "../permission/engine.mjs"

export function createPermissionCommand() {
  const cmd = new Command("permission").description("inspect permission rules and session grants")

  cmd
    .command("show")
    .description("show configured permission policy")
    .action(async () => {
      const kernel = await createKernel({ cwd: process.cwd(), boot: false })
      const themeState = await loadTheme(kernel.configState)
      printContextWarnings({ configState: kernel.configState, themeState })
      console.log(JSON.stringify(kernel.configState.config.permission, null, 2))
    })

  cmd
    .command("session")
    .description("show granted allow_session keys for one session")
    .requiredOption("--id <id>", "session id")
    .action(async (options) => {
      const list = PermissionEngine.listSession(options.id)
      console.log(JSON.stringify(list, null, 2))
    })

  cmd
    .command("reset")
    .description("clear in-memory grants for one session")
    .requiredOption("--id <id>", "session id")
    .action(async (options) => {
      PermissionEngine.clearSession(options.id)
      console.log(`permission cache cleared for session ${options.id}`)
    })

  return cmd
}
