import { Command } from "commander"
import { buildContext, printContextWarnings } from "../context.mjs"
import { McpRegistry } from "../mcp/registry.mjs"

export function createMcpCommand() {
  const cmd = new Command("mcp").description("manage MCP servers and tools")

  cmd
    .command("list")
    .description("list configured and healthy MCP servers")
    .action(async () => {
      const ctx = await buildContext()
      printContextWarnings(ctx)
      await McpRegistry.initialize(ctx.configState.config)
      console.log(JSON.stringify(McpRegistry.listServers(), null, 2))
    })

  cmd
    .command("tools")
    .description("list MCP tools")
    .action(async () => {
      const ctx = await buildContext()
      printContextWarnings(ctx)
      await McpRegistry.initialize(ctx.configState.config)
      console.log(JSON.stringify(McpRegistry.listTools(), null, 2))
    })

  cmd
    .command("resources")
    .description("list resources for MCP server")
    .requiredOption("--server <name>", "server name")
    .action(async (options) => {
      const ctx = await buildContext()
      printContextWarnings(ctx)
      await McpRegistry.initialize(ctx.configState.config)
      const list = await McpRegistry.listResources(options.server)
      console.log(JSON.stringify(list, null, 2))
    })

  cmd
    .command("templates")
    .description("list templates for MCP server")
    .requiredOption("--server <name>", "server name")
    .action(async (options) => {
      const ctx = await buildContext()
      printContextWarnings(ctx)
      await McpRegistry.initialize(ctx.configState.config)
      const list = await McpRegistry.listTemplates(options.server)
      console.log(JSON.stringify(list, null, 2))
    })

  cmd
    .command("test")
    .description("test MCP health and tool discovery")
    .option("--json", "print JSON output", false)
    .action(async (options) => {
      const ctx = await buildContext()
      printContextWarnings(ctx)
      await McpRegistry.initialize(ctx.configState.config)
      const snapshot = McpRegistry.healthSnapshot()
      const tools = McpRegistry.listTools()
      const healthy = snapshot.filter((item) => item.ok).length
      const unhealthy = snapshot.length - healthy

      if (options.json) {
        console.log(JSON.stringify({
          configured: snapshot.length,
          healthy,
          unhealthy,
          tools: tools.length,
          servers: snapshot
        }, null, 2))
        return
      }

      console.log(`configured: ${snapshot.length}`)
      console.log(`healthy: ${healthy}`)
      console.log(`unhealthy: ${unhealthy}`)
      console.log(`tools: ${tools.length}`)
      for (const item of snapshot) {
        const status = item.ok ? "ok" : "fail"
        const reason = item.reason || "-"
        const error = item.error ? ` | ${item.error}` : ""
        console.log(`- ${item.name} [${item.transport}] ${status} (${reason})${error}`)
      }
    })

  return cmd
}
