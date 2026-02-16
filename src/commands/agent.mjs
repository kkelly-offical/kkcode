import { Command } from "commander"
import { buildContext, printContextWarnings } from "../context.mjs"
import { LongAgentManager } from "../orchestration/longagent-manager.mjs"

export function createAgentCommand() {
  const cmd = new Command("agent").description("inspect subagents and longagent runs")

  cmd
    .command("list")
    .description("list configured subagents")
    .action(async () => {
      const ctx = await buildContext()
      printContextWarnings(ctx)
      console.log(JSON.stringify(ctx.configState.config.agent.subagents || {}, null, 2))
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
