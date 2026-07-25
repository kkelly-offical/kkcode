import { Command } from "commander"
import { readFile } from "node:fs/promises"
import { LongAgentManager } from "../orchestration/longagent-manager.mjs"
import { loadConfig } from "../config/load-config.mjs"
import { eventLogPath } from "../storage/paths.mjs"
import { formatRecoverySuggestions } from "../ui/activity-renderer.mjs"
import { loadLedger } from "../session/ultra-ledger.mjs"
import { buildBlockedReport, renderBlockedReportText } from "../session/blocked-report.mjs"

/**
 * Ultra 会话管理。0.4.0 起主命令是 `kkcode ultra`，`kkcode longagent`
 * 作为别名保留到 0.5.0。
 */
export function createLongagentCommand({ name = "ultra" } = {}) {
  const cmd = new Command(name)
    .alias(name === "ultra" ? "longagent" : "ultra")
    .description("manage Ultra (staged delivery) sessions")

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
      if (item.goal) {
        console.log("\n=== goal ===")
        console.log(`objective: ${item.goal.objective}`)
        console.log(`intent: ${item.goal.intent}`)
        for (const c of item.goal.criteria || []) {
          console.log(`  [${c.kind}] ${c.text}`)
        }
        for (const s of item.goal.subGoals || []) {
          console.log(`  subgoal ${s.title} (${(s.stageIds || []).join(",")})${s.optional ? " [optional]" : ""}`)
        }
      }
    })

  cmd
    .command("report")
    .description("render the goal report for a longagent session from its ledger")
    .requiredOption("--session <id>", "session id")
    .option("--json", "print the structured report as JSON")
    .action(async (options) => {
      const ledger = await loadLedger(options.session)
      if (!ledger) {
        console.error(`no ledger found for session: ${options.session}`)
        process.exitCode = 1
        return
      }
      const report = buildBlockedReport(ledger)
      if (options.json) {
        console.log(JSON.stringify(report, null, 2))
        return
      }
      for (const line of renderBlockedReportText(report)) console.log(line)
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

  cmd
    .command("logs")
    .description("view longagent event logs")
    .option("--session <id>", "filter by session id")
    .option("-n, --lines <n>", "number of recent lines", "50")
    .option("--json", "output raw JSON lines")
    .action(async (options) => {
      const logFile = eventLogPath()
      let raw
      try {
        raw = await readFile(logFile, "utf8")
      } catch {
        console.error(`no event log found at ${logFile}`)
        process.exitCode = 1
        return
      }
      const allLines = raw.trim().split("\n").filter(Boolean)
      let events = allLines.map((line) => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)

      if (options.session) {
        events = events.filter((e) => e.sessionId === options.session)
      }
      // filter longagent-related events
      events = events.filter((e) =>
        String(e.type || "").includes("longagent") ||
        String(e.type || "").includes("stage") ||
        String(e.type || "").includes("task")
      )
      const limit = Math.max(1, Number(options.lines) || 50)
      events = events.slice(-limit)

      if (options.json) {
        for (const e of events) console.log(JSON.stringify(e))
        return
      }
      if (!events.length) {
        console.log("no longagent events found")
        return
      }
      for (const e of events) {
        const ts = e.timestamp ? new Date(e.timestamp).toISOString().slice(11, 19) : "??:??:??"
        const sid = e.sessionId ? e.sessionId.slice(0, 12) : "????????????"
        const payload = e.payload ? JSON.stringify(e.payload).slice(0, 120) : ""
        console.log(`${ts} [${sid}] ${e.type || "unknown"}${payload ? " " + payload : ""}`)
      }
    })

  cmd
    .command("config")
    .description("show effective longagent configuration")
    .option("--full", "show full merged config (not just longagent section)")
    .action(async (options) => {
      const configState = await loadConfig()
      if (options.full) {
        console.log(JSON.stringify(configState.config, null, 2))
        return
      }
      const la = configState.config.agent?.longagent || {}
      console.log("## longagent config")
      console.log(JSON.stringify(la, null, 2))
      console.log("\n## sources")
      console.log(`  user:    ${configState.source.userPath || "(none)"}`)
      console.log(`  project: ${configState.source.projectPath || "(none)"}`)
      console.log(`  env:     ${configState.source.envPath || "(none)"}`)
      if (configState.errors.length) {
        console.log("\n## errors")
        for (const e of configState.errors) console.log(`  - ${e}`)
      }
    })

  cmd
    .command("start")
    .description("launch a longagent session with a prompt")
    .argument("<prompt>", "task description for longagent")
    .option("--model <model>", "override model")
    .option("--provider <type>", "override provider type")
    .option("--max-iterations <n>", "max iterations (0=unlimited)", "0")
    .action(async (prompt, options) => {
      const configState = await loadConfig()
      const providerKey = options.provider || configState.config.provider.default
      const providerConf = configState.config.provider[providerKey] || {}
      const model = options.model || providerConf.default_model
      if (!model) {
        console.error(`no model configured for provider "${providerKey}"`)
        process.exitCode = 1
        return
      }
      const { executeTurn } = await import("../session/engine.mjs")
      const { newSessionId } = await import("../session/engine.mjs")
      const sessionId = newSessionId()
      console.log(`starting longagent session: ${sessionId}`)
      console.log(`model: ${model}, provider: ${providerKey}`)
      try {
        const result = await executeTurn({
          prompt,
          mode: "longagent",
          model,
          sessionId,
          configState: { config: configState.config, source: configState.source },
          providerType: providerKey,
          baseUrl: providerConf.base_url || null,
          apiKeyEnv: providerConf.api_key_env || null,
          maxIterations: Number(options.maxIterations) || 0,
          output: { write: (t) => process.stdout.write(t) }
        })
        // executeTurn 返回的对象没有顶层 status —— 它在 result.longagent.status。
        // 0.4.x 读的是 result.status，恒为 undefined，所以这行**永远**打印 done，
        // 哪怕这一轮其实是 failed 或 aborted。
        const ultra = result.longagent || {}
        console.log(`\nsession ${sessionId} finished (status: ${ultra.status || "unknown"})`)
        if (ultra.blockedReport) {
          console.log("")
          for (const line of renderBlockedReportText(ultra.blockedReport)) console.log(line)
        } else if (ultra.recoverySuggestions) {
          for (const line of formatRecoverySuggestions(ultra.recoverySuggestions)) {
            console.log(line)
          }
        }
        if (ultra.reportPath) console.log(`\nreport: ${ultra.reportPath}`)
        if (ultra.status === "failed") process.exitCode = 1
      } catch (err) {
        console.error(`longagent error: ${err.message}`)
        process.exitCode = 1
      }
    })

  return cmd
}
