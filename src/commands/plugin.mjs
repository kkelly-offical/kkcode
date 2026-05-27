import { Command } from "commander"
import { buildContext } from "../context.mjs"
import { discoverLocalPluginManifests } from "../plugin/manifest-loader.mjs"

export function createPluginCommand() {
  const cmd = new Command("plugin").description("inspect local plugin compatibility packages")

  cmd
    .command("list")
    .description("list discovered local plugin manifests")
    .option("--json", "print structured output", false)
    .action(async (options) => {
      const ctx = await buildContext()
      const result = await discoverLocalPluginManifests(process.cwd(), ctx.configState.config)
      const plugins = result.plugins.map((plugin) => ({
        name: plugin.name,
        version: plugin.version,
        displayName: plugin.displayName,
        sourceEcosystem: plugin.sourceEcosystem || plugin.ecosystem || "kkcode",
        enabled: plugin.enabled !== false,
        scope: plugin.scope,
        source: plugin.source,
        rootDir: plugin.rootDir,
        components: {
          skills: plugin.skills?.length || 0,
          agents: plugin.agents?.length || 0,
          hooks: plugin.hooks?.length || 0,
          mcpServers: Object.keys(plugin.mcpServers || {}).length
        },
        unsupported: plugin.unsupported || []
      }))

      if (options.json) {
        console.log(JSON.stringify({ ok: true, total: plugins.length, plugins, diagnostics: result.errors }, null, 2))
        return
      }

      if (!plugins.length) {
        console.log("no local plugins discovered")
      } else {
        for (const plugin of plugins) {
          console.log(`- ${plugin.name} [${plugin.sourceEcosystem}] ${plugin.enabled ? "enabled" : "disabled"} (${plugin.source})`)
        }
      }
      if (result.errors.length) {
        console.log("diagnostics:")
        for (const item of result.errors) console.log(`- ${item}`)
      }
    })

  return cmd
}
