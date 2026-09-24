import { Command } from "commander"
import { createKernel, discoverLocalPluginManifests, installPlugin, managePlugin } from "../kernel/index.mjs"

export function createPluginCommand() {
  const cmd = new Command("plugin").description("inspect local plugin compatibility packages")
  cmd.command('install <name> <source>').option('--revision <sha>', 'Exact Git commit').action(async (name, source, options) => console.log(JSON.stringify(await installPlugin({ name, source, revision: options.revision }))))
  for (const action of ['enable', 'disable', 'remove']) cmd.command(`${action} <name>`).action(async name => console.log(JSON.stringify(await managePlugin(name, action))))
  cmd.command('update <name>').option('--source <source>', '新的精确npm版本、本地源或Git URL').option('--revision <sha>', '新的完整Git commit SHA').action(async (name, options) => console.log(JSON.stringify(await managePlugin(name, 'update', options))))
  cmd.command('inspect <name>').description('检查托管插件的内容哈希、能力与批准状态').action(async name => console.log(JSON.stringify(await managePlugin(name, 'inspect'), null, 2)))
  cmd.command('approve <name>').description('按已检查的内容哈希批准新增能力；执行型插件拥有宿主权限').requiredOption('--confirm-hash <sha256>', '必须匹配当前完整插件内容').action(async (name, options) => console.log(JSON.stringify(await managePlugin(name, 'approve', options))))

  cmd
    .command("list")
    .description("list discovered local plugin manifests")
    .option("--json", "print structured output", false)
    .action(async (options) => {
      const kernel = await createKernel({ cwd: process.cwd(), boot: false })
      const result = await discoverLocalPluginManifests(process.cwd(), kernel.configState.config)
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
