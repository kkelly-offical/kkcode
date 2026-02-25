import { Command } from "commander"
import { exec as execCb } from "node:child_process"
import { promisify } from "node:util"
import { buildContext } from "../context.mjs"
import { listProviders } from "../provider/router.mjs"
import { eventLogStats } from "../storage/event-log.mjs"
import { auditStats } from "../storage/audit-store.mjs"
import { fsckSessionStore, flushNow } from "../session/store.mjs"
import { BackgroundManager } from "../orchestration/background-manager.mjs"
import { McpRegistry } from "../mcp/registry.mjs"

const exec = promisify(execCb)

async function hasCommand(cmd) {
  const query = process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`
  try {
    await exec(query)
    return true
  } catch {
    return false
  }
}

function summarizeBackground(tasks) {
  const counters = {
    total: tasks.length,
    pending: 0,
    running: 0,
    completed: 0,
    error: 0,
    cancelled: 0,
    interrupted: 0
  }
  for (const task of tasks) {
    if (counters[task.status] !== undefined) counters[task.status] += 1
  }
  return counters
}

async function buildDoctorReport() {
  const ctx = await buildContext()
  await flushNow()
  await BackgroundManager.tick(ctx.configState.config)

  const checks = {
    node: true,
    rg: await hasCommand("rg"),
    git: await hasCommand("git")
  }

  const config = ctx.configState.config
  const providers = []
  for (const [name, provider] of Object.entries(config.provider || {})) {
    if (name === "default") continue
    if (!provider || typeof provider !== "object") continue
    const keyEnv = provider.api_key_env || ""
    providers.push({
      name,
      type: provider.type || name,
      model: provider.default_model || null,
      baseUrl: provider.base_url || null,
      apiKeyEnv: keyEnv || null,
      apiKeyConfigured: keyEnv ? Boolean(process.env[keyEnv]) : true
    })
  }

  const events = await eventLogStats()
  const audit = await auditStats()
  const storage = await fsckSessionStore()
  const backgroundTasks = await BackgroundManager.list()
  await McpRegistry.initialize(config)
  const mcpSnapshot = McpRegistry.healthSnapshot()
  const mcpHealthy = mcpSnapshot.filter((item) => item.ok).length

  return {
    ok: storage.ok,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    themeWarnings: ctx.themeState.errors,
    config: {
      defaultProvider: config.provider?.default || null,
      userPath: ctx.configState.source.userPath,
      projectPath: ctx.configState.source.projectPath,
      warnings: ctx.configState.errors
    },
    runtime: {
      providersRegistered: listProviders(),
      providersConfigured: providers
    },
    checks,
    mcp: {
      configured: mcpSnapshot.length,
      healthy: mcpHealthy,
      unhealthy: mcpSnapshot.length - mcpHealthy,
      servers: mcpSnapshot
    },
    storage: {
      sessions: storage,
      eventLog: events,
      audit
    },
    background: summarizeBackground(backgroundTasks)
  }
}

function printTextReport(report, themeWarnings = []) {
  console.log("kkcode doctor")
  console.log(`time: ${report.timestamp}`)
  console.log(`cwd: ${report.cwd}`)
  console.log(`default provider: ${report.config.defaultProvider}`)
  console.log(`config.user: ${report.config.userPath || "(none)"}`)
  console.log(`config.project: ${report.config.projectPath || "(none)"}`)
  if (report.config.warnings.length) {
    for (const warning of report.config.warnings) {
      console.log(`config warning: ${warning}`)
    }
  }
  for (const warning of themeWarnings) {
    console.log(`theme warning: ${warning}`)
  }
  for (const p of report.runtime.providersConfigured) {
    console.log(
      `provider:${p.name} type=${p.type} model=${p.model || "?"} env=${p.apiKeyEnv || "-"} (${p.apiKeyConfigured ? "set" : "missing"})`
    )
  }
  console.log(`check node=${report.checks.node ? "ok" : "missing"} rg=${report.checks.rg ? "ok" : "missing"} git=${report.checks.git ? "ok" : "missing"}`)
  console.log(`mcp: configured=${report.mcp.configured} healthy=${report.mcp.healthy} unhealthy=${report.mcp.unhealthy}`)
  console.log(`sessions: ok=${report.storage.sessions.ok} index=${report.storage.sessions.sessionsInIndex} files=${report.storage.sessions.filesOnDisk}`)
  console.log(`events: active=${report.storage.eventLog.activeBytes} rotated=${report.storage.eventLog.rotatedFiles}`)
  console.log(`audit: total=${report.storage.audit.total} error1h=${report.storage.audit.error1h} error24h=${report.storage.audit.error24h}`)
  console.log(
    `background: total=${report.background.total} running=${report.background.running} pending=${report.background.pending} interrupted=${report.background.interrupted} error=${report.background.error}`
  )
}

export function createDoctorCommand() {
  return new Command("doctor")
    .description("run environment diagnostics")
    .option("--json", "print structured diagnostics", false)
    .action(async (options) => {
      const report = await buildDoctorReport()
      if (options.json) {
        console.log(JSON.stringify(report, null, 2))
        return
      }
      printTextReport(report, report.themeWarnings || [])
    })
}
