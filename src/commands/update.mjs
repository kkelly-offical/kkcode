import { Command } from "commander"
import { loadConfig } from "../config/load-config.mjs"
import { PACKAGE_VERSION } from "../version.mjs"
import { checkForUpdate, installUpdate, updateMessage } from "../update/checker.mjs"

export function createUpdateCommand() {
  return new Command("update")
    .description("check for and install kkcode updates")
    .option("--check", "only check for updates", false)
    .option("--install", "install the selected update", false)
    .option("--channel <channel>", "npm dist-tag to follow", null)
    .option("--json", "print structured result", false)
    .action(async (options) => {
      const state = await loadConfig(process.cwd())
      const config = { ...state.config, update: { ...(state.config.update || {}) } }
      if (options.channel) config.update.channel = options.channel
      const result = await checkForUpdate(config, { force: true, currentVersion: PACKAGE_VERSION })
      if (options.json) {
        console.log(JSON.stringify(result, null, 2))
      } else if (result.hasUpdate) {
        console.log(updateMessage(result))
      } else {
        console.log(`kkcode is up to date (${result.currentVersion}) on ${result.channel}`)
      }

      if (options.check || !options.install) return
      if (!result.hasUpdate) return
      const installed = await installUpdate(config, { channel: result.channel })
      if (!installed.ok) throw new Error(`update install failed: ${installed.error}`)
      console.log(`installed kkcode ${result.latestVersion}; restart your shell or kkcode session if needed`)
    })
}
