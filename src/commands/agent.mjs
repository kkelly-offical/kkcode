import { Command } from "commander"
import { buildContext, printContextWarnings, resolveExtensionPolicy } from "../context.mjs"
import { LongAgentManager } from "../orchestration/longagent-manager.mjs"
import { listAgents } from "../agent/agent.mjs"
import { CustomAgentRegistry } from "../agent/custom-agent-loader.mjs"

export function createAgentCommand() {
  const cmd = new Command("agent").description("inspect subagents and longagent runs")

  cmd
    .command("list")
    .description("list active subagent roles and configured overrides")
    .option("--json", "print structured JSON")
    .option("--configured", "print only config-defined agent.subagents overrides")
    .option("--include-hidden", "include hidden internal roles")
    .action(async (options) => {
      const ctx = await buildContext()
      printContextWarnings(ctx)
      const extensionPolicy = resolveExtensionPolicy(ctx.configState)
      await CustomAgentRegistry.initialize(process.cwd(), {
        allowProjectSources: extensionPolicy.allowProjectSources
      })
      const configured = ctx.configState.config.agent?.subagents || {}
      if (options.configured) {
        console.log(JSON.stringify(configured, null, 2))
        return
      }
      const roles = listAgents({ includeHidden: options.includeHidden === true })
        .filter((agent) => agent.mode === "subagent")
        .map((agent) => {
          const override = configured[agent.name] || null
          return {
            name: agent.name,
            description: agent.description || "",
            permission: agent.permission || "default",
            model: override?.model || agent.model || null,
            providerType: override?.providerType || override?.provider_type || null,
            tools: agent.tools || null,
            custom: agent._customAgent === true,
            scope: agent._scope || null,
            source: agent._source || null,
            configured: Boolean(override)
          }
        })
      if (options.json) {
        console.log(JSON.stringify(roles, null, 2))
        return
      }
      for (const role of roles) {
        const flags = [role.permission, role.custom ? "custom" : "builtin", role.configured ? "configured" : ""].filter(Boolean).join(", ")
        const model = role.model ? " model=" + role.model : ""
        const provider = role.providerType ? " provider=" + role.providerType : ""
        console.log(role.name + " [" + flags + "]" + model + provider)
        if (role.description) console.log("  " + role.description)
      }
    })

  cmd
    .command("status")
    .description("show longagent session status")
    .option("--session <id>", "session id")
    .action(async (options) => {
      if (options.session) {
        const item = await LongAgentManager.get(options.session)
        if (!item) {
          console.error(`not found: ${options.session}`)
          process.exitCode = 1
          return
        }
        console.log(JSON.stringify(item, null, 2))
        return
      }
      const list = await LongAgentManager.list()
      console.log(JSON.stringify(list, null, 2))
    })

  cmd
    .command("stop")
    .description("emergency stop for running longagent session")
    .requiredOption("--session <id>", "session id")
    .option("--force", "confirm emergency stop")
    .action(async (options) => {
      if (!options.force) {
        console.error("agent stop is emergency-only. re-run with --force to confirm.")
        process.exitCode = 1
        return
      }
      const out = await LongAgentManager.stop(options.session)
      if (!out) {
        console.error(`not found: ${options.session}`)
        process.exitCode = 1
        return
      }
      console.log(`emergency stop requested: ${options.session}`)
    })

  cmd
    .command("resume")
    .description("clear stop flag for longagent session")
    .requiredOption("--session <id>", "session id")
    .action(async (options) => {
      const out = await LongAgentManager.clearStop(options.session)
      if (!out) {
        console.error(`not found: ${options.session}`)
        process.exitCode = 1
        return
      }
      console.log(`stop flag cleared: ${options.session}`)
    })

  return cmd
}
