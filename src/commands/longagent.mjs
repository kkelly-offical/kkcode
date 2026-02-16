import { Command } from "commander"
import { LongAgentManager } from "../orchestration/longagent-manager.mjs"

export function createLongagentCommand() {
  const cmd = new Command("longagent").description("manage longagent sessions")

  cmd
    .command("status")
    .description("show one longagent session or list all")
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
    .command("plan")
    .description("show frozen stage plan for a longagent session")
    .requiredOption("--session <id>", "session id")
    .action(async (options) => {
      const item = await LongAgentManager.get(options.session)
      if (!item) {
        console.error(`not found: ${options.session}`)
        process.exitCode = 1
        return
      }
      if (!item.stagePlan) {
        console.error(`no frozen plan found for session: ${options.session}`)
        process.exitCode = 1
        return
      }
      console.log(JSON.stringify(item.stagePlan, null, 2))
    })

  cmd
    .command("stop")
    .description("emergency stop for a running longagent session")
    .requiredOption("--session <id>", "session id")
    .option("--force", "confirm emergency stop")
    .action(async (options) => {
      if (!options.force) {
        console.error("longagent stop is emergency-only. re-run with --force to confirm.")
        process.exitCode = 1
        return
      }
      const result = await LongAgentManager.stop(options.session)
      if (!result) {
        console.error(`not found: ${options.session}`)
        process.exitCode = 1
        return
      }
      console.log(`emergency stop requested: ${options.session}`)
    })

  cmd
    .command("resume")
    .description("clear stop flag for session")
    .requiredOption("--session <id>", "session id")
    .action(async (options) => {
      const result = await LongAgentManager.clearStop(options.session)
      if (!result) {
        console.error(`not found: ${options.session}`)
        process.exitCode = 1
        return
      }
      console.log(`stop flag cleared: ${options.session}`)
    })

  cmd
    .command("stage-retry")
    .description("mark one stage for manual retry in longagent state")
    .requiredOption("--session <id>", "session id")
    .requiredOption("--stage <id>", "stage id")
    .action(async (options) => {
      const current = await LongAgentManager.get(options.session)
      if (!current) {
        console.error(`not found: ${options.session}`)
        process.exitCode = 1
        return
      }
      const out = await LongAgentManager.update(options.session, {
        retryStageId: options.stage,
        stageStatus: "retry_requested",
        stopRequested: false
      })
      console.log(`stage retry requested: ${options.stage} (session=${out.sessionId})`)
    })

  return cmd
}
