import path from "node:path"
import { writeFile } from "node:fs/promises"
import { Command } from "commander"
import { exportSession, getSession, listSessions, forkSession, fsckSessionStore, gcSessionStore, flushNow } from "../session/store.mjs"
import { newSessionId, executeTurn } from "../session/engine.mjs"
import { listRecoverableSessions, getResumeContext, isRecoveryEnabled } from "../session/recovery.mjs"
import { buildContext } from "../context.mjs"
import { ToolRegistry } from "../tool/registry.mjs"

function assertRecoveryEnabled(config, commandName) {
  if (isRecoveryEnabled(config)) return true
  console.error(`session recovery is disabled (session.recovery=false). command "${commandName}" is unavailable.`)
  process.exitCode = 2
  return false
}

export function createSessionCommand() {
  const cmd = new Command("session").description("manage persisted kkcode sessions")

  cmd
    .command("fsck")
    .description("check session index/data consistency")
    .option("--json", "print as json", false)
    .action(async (options) => {
      const report = await fsckSessionStore()
      if (options.json) {
        console.log(JSON.stringify(report, null, 2))
        return
      }
      console.log(`checked_at=${new Date(report.checkedAt).toLocaleString()}`)
      console.log(`sessions_in_index=${report.sessionsInIndex} files_on_disk=${report.filesOnDisk}`)
      console.log(`missing_data_files=${report.missingDataFiles.length}`)
      console.log(`orphan_data_files=${report.orphanDataFiles.length}`)
      console.log(`invalid_data_files=${report.invalidDataFiles.length}`)
      for (const suggestion of report.suggestions) {
        console.log(`suggestion: ${suggestion}`)
      }
      if (!report.ok) process.exitCode = 2
    })

  cmd
    .command("gc")
    .description("clean orphan/stale session data")
    .option("--orphans-only", "only remove orphan session files", false)
    .option("--max-age <days>", "remove stale sessions older than days", "30")
    .option("--json", "print as json", false)
    .action(async (options) => {
      const result = await gcSessionStore({
        orphansOnly: Boolean(options.orphansOnly),
        maxAgeDays: Number(options.maxAge || 30)
      })
      await flushNow()
      if (options.json) {
        console.log(JSON.stringify(result, null, 2))
        return
      }
      console.log(`removed orphan files: ${result.removed.orphanFiles.length}`)
      console.log(`removed stale sessions: ${result.removed.staleSessions.length}`)
      console.log(`removed checkpoint dirs: ${result.removed.checkpointDirs.length}`)
      console.log(`total removed: ${result.totalRemoved}`)
    })

  cmd
    .command("list")
    .description("list sessions")
    .option("--cwd-only", "filter by cwd", false)
    .option("--roots", "only root sessions", false)
    .option("--limit <n>", "max sessions", "30")
    .action(async (options) => {
      const list = await listSessions({
        cwd: options.cwdOnly ? process.cwd() : null,
        includeChildren: !options.roots,
        limit: Number(options.limit || 30)
      })
      if (!list.length) {
        console.log("no sessions found")
        return
      }
      for (const session of list) {
        const parent = session.parentSessionId ? ` parent=${session.parentSessionId}` : ""
        console.log(
          `${session.id}  ${session.mode}  ${session.providerType}  ${session.model}  ${new Date(session.updatedAt).toLocaleString()}${parent}`
        )
      }
    })

  cmd
    .command("show")
    .description("show one session")
    .requiredOption("--id <id>", "session id")
    .action(async (options) => {
      const data = await getSession(options.id)
      if (!data) {
        console.error(`session not found: ${options.id}`)
        process.exitCode = 1
        return
      }
      console.log(JSON.stringify(data, null, 2))
    })

  cmd
    .command("export")
    .description("export session to json")
    .requiredOption("--id <id>", "session id")
    .option("--out <file>", "output file")
    .action(async (options) => {
      const data = await exportSession(options.id)
      if (!data) {
        console.error(`session not found: ${options.id}`)
        process.exitCode = 1
        return
      }
      const out = options.out ? path.resolve(options.out) : path.resolve(`session-${options.id}.json`)
      await writeFile(out, JSON.stringify(data, null, 2) + "\n", "utf8")
      console.log(`exported: ${out}`)
    })

  cmd
    .command("fork")
    .description("fork session into a new child session")
    .requiredOption("--id <id>", "source session id")
    .option("--new-id <id>", "new session id")
    .option("--title <title>", "child title")
    .action(async (options) => {
      const newId = options.newId || newSessionId()
      const out = await forkSession({
        sessionId: options.id,
        newSessionId: newId,
        title: options.title || null
      })
      if (!out) {
        console.error(`session not found: ${options.id}`)
        process.exitCode = 1
        return
      }
      console.log(`forked: ${newId} <- ${options.id}`)
    })

  cmd
    .command("resume")
    .description("resume a session from the last user message")
    .requiredOption("--id <id>", "session id to resume")
    .option("--mode <mode>", "override mode")
    .option("--model <model>", "override model")
    .action(async (options) => {
      const ctx = await buildContext()
      if (!assertRecoveryEnabled(ctx.configState.config, "session resume")) return

      const resumeCtx = await getResumeContext(options.id, { enabled: true })
      if (!resumeCtx) {
        console.error(`session not found: ${options.id}`)
        process.exitCode = 1
        return
      }
      if (!resumeCtx.canResume) {
        console.error(`no user message found in session ${options.id}`)
        process.exitCode = 1
        return
      }
      await ToolRegistry.initialize({ config: ctx.configState.config, cwd: process.cwd() })
      const mode = options.mode || resumeCtx.session.mode
      const model = options.model || resumeCtx.session.model
      console.log(`resuming session ${options.id} (${resumeCtx.messageCount} messages)`)
      console.log(`last prompt: ${resumeCtx.lastPrompt.slice(0, 100)}${resumeCtx.lastPrompt.length > 100 ? "..." : ""}`)
      const result = await executeTurn({
        prompt: resumeCtx.lastPrompt,
        mode,
        model,
        sessionId: options.id,
        configState: ctx.configState,
        providerType: resumeCtx.session.providerType
      })
      console.log(result.reply)
    })

  cmd
    .command("retry")
    .description("retry the last failed turn in a session")
    .requiredOption("--id <id>", "session id to retry")
    .action(async (options) => {
      const ctx = await buildContext()
      if (!assertRecoveryEnabled(ctx.configState.config, "session retry")) return

      const resumeCtx = await getResumeContext(options.id, { enabled: true })
      if (!resumeCtx) {
        console.error(`session not found: ${options.id}`)
        process.exitCode = 1
        return
      }
      if (!resumeCtx.canRetry) {
        console.error(`session ${options.id} has no failed turn to retry`)
        process.exitCode = 1
        return
      }
      if (!resumeCtx.canResume) {
        console.error(`no user message found in session ${options.id}`)
        process.exitCode = 1
        return
      }
      await ToolRegistry.initialize({ config: ctx.configState.config, cwd: process.cwd() })
      console.log(`retrying failed turn in session ${options.id}`)
      const result = await executeTurn({
        prompt: resumeCtx.lastPrompt,
        mode: resumeCtx.session.mode,
        model: resumeCtx.session.model,
        sessionId: options.id,
        configState: ctx.configState,
        providerType: resumeCtx.session.providerType
      })
      console.log(result.reply)
    })

  cmd
    .command("recoverable")
    .description("list sessions that can be resumed or retried")
    .action(async () => {
      const ctx = await buildContext()
      if (!assertRecoveryEnabled(ctx.configState.config, "session recoverable")) return

      const sessions = await listRecoverableSessions({
        cwd: process.cwd(),
        enabled: true
      })
      if (!sessions.length) {
        console.log("no recoverable sessions")
        return
      }
      for (const s of sessions) {
        const reason = s.retryMeta?.inProgress ? "in-progress" : s.status === "error" ? "error" : "unknown"
        console.log(`${s.id}  ${s.mode}  ${reason}  ${new Date(s.updatedAt).toLocaleString()}`)
      }
    })

  return cmd
}
