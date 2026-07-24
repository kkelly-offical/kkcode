import { Command } from "commander"
import { exec as execCb } from "node:child_process"
import { promisify } from "node:util"
import { buildContext, resolveExtensionPolicy } from "../context.mjs"
import { listProviders } from "../provider/router.mjs"
import { eventLogStats } from "../storage/event-log.mjs"
import { auditStats, verifyAuditChain } from "../storage/audit-store.mjs"
import { fsckSessionStore, flushNow } from "../session/store.mjs"
import { BackgroundManager } from "../orchestration/background-manager.mjs"
import { McpRegistry } from "../mcp/registry.mjs"
import { SkillRegistry } from "../skill/registry.mjs"
import { buildRequestHeaders, redactHeaders } from "../http/identity.mjs"
import { resolveProviderConnection } from "../provider/model-catalog.mjs"

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

export async function buildDoctorReport({ includeHttp = false } = {}) {
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
    if (["default", "strict_mode", "model_context"].includes(name)) continue
    if (!provider || typeof provider !== "object") continue
    const keyEnv = provider.api_key_env || ""
    const type = provider.type || name
    const supportsCatalog = ["openai", "openai-compatible", "anthropic", "gateway"].includes(type)
    let connection = null
    let modelCatalogError = null
    if (supportsCatalog) {
      try {
        connection = resolveProviderConnection(ctx.configState, name)
      } catch (error) {
        modelCatalogError = error?.message || "invalid model catalog configuration"
      }
    }
    const protocol = connection?.protocol || provider.protocol ||
      (type === "anthropic" ? "anthropic" : type === "ollama" ? "ollama" : "openai")
    const baseUrl = connection?.baseUrl || provider.endpoints?.[protocol] || provider.base_url || null
    const modelsUrl = connection?.modelsUrl || null
    providers.push({
      name,
      type,
      protocol,
      model: provider.default_model || null,
      baseUrl,
      modelsUrl,
      modelCatalogError,
      apiKeyEnv: keyEnv || null,
      usesCredential: Boolean(provider.api_key || keyEnv),
      apiKeyConfigured: Boolean(provider.api_key || !keyEnv || process.env[keyEnv])
    })
  }

  const events = await eventLogStats()
  const audit = await auditStats()
  const auditIntegrity = await verifyAuditChain()
  const storage = await fsckSessionStore()
  const backgroundTasks = await BackgroundManager.list()
  const extensionPolicy = resolveExtensionPolicy(ctx.configState)
  const extensionConfig = {
    ...extensionPolicy.config,
    skills: { ...(extensionPolicy.config.skills || {}), auto_seed: false }
  }
  await McpRegistry.initialize(extensionPolicy.config, {
    cwd: process.cwd(),
    allowProjectSources: extensionPolicy.allowProjectSources
  })
  await SkillRegistry.initialize(extensionConfig, process.cwd(), {
    allowProjectSources: extensionPolicy.allowProjectSources
  })
  const mcpSnapshot = McpRegistry.healthSnapshot()
  const mcpHealthy = mcpSnapshot.filter((item) => item.ok).length
  const skillList = SkillRegistry.list()
  const skillSummary = {
    enabled: config.skills?.enabled !== false,
    autoSeed: config.skills?.auto_seed !== false,
    total: skillList.length,
    template: skillList.filter((s) => s.type === "template").length,
    skillMd: skillList.filter((s) => s.type === "skill_md").length,
    mcpPrompt: skillList.filter((s) => s.type === "mcp_prompt").length,
    programmable: skillList.filter((s) => s.type === "mjs").length
  }
  const pluginManifests = SkillRegistry.listPluginManifests()
  const compatDiagnostics = SkillRegistry.compatDiagnostics()
  const strictCompatFailed = config.compat?.diagnostics?.strict === true && compatDiagnostics.length > 0
  const compatSummary = {
    ecosystems: [...new Set([
      ...skillList.map((s) => s.sourceEcosystem || "kkcode"),
      ...pluginManifests.map((p) => p.sourceEcosystem || p.ecosystem || "kkcode")
    ])].sort(),
    plugins: pluginManifests.length,
    skills: skillList.length,
    unsupported: compatDiagnostics.filter((item) => String(item).includes("unsupported_component")).length,
    diagnostics: compatDiagnostics,
    strictFailed: strictCompatFailed
  }

  const http = includeHttp ? {
    identity: redactHeaders(buildRequestHeaders({ target: "doctor" })),
    providers: providers.map((provider) => ({
      name: provider.name,
      baseUrl: provider.baseUrl,
      modelsUrl: provider.modelsUrl,
      modelCatalogError: provider.modelCatalogError,
      protocol: provider.protocol,
      headers: redactHeaders(buildRequestHeaders({
        target: "model-discovery",
        provider: provider.name,
        protocol: provider.protocol,
        openAIClientRequestId: provider.protocol === "openai",
        accept: "application/json",
        contentType: "application/json",
        authorization: provider.protocol === "openai" && provider.apiKeyConfigured && provider.usesCredential
          ? "Bearer configured"
          : "",
        customHeaders: provider.protocol === "anthropic" && provider.apiKeyConfigured && provider.usesCredential
          ? { "x-api-key": "configured", "anthropic-version": "2023-06-01" }
          : {}
      }))
    }))
  } : undefined

  return {
    ok: storage.ok && auditIntegrity.ok && !strictCompatFailed,
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
    skills: skillSummary,
    compat: compatSummary,
    storage: {
      sessions: storage,
      eventLog: events,
      audit: {
        ...audit,
        integrity: auditIntegrity
      }
    },
    background: summarizeBackground(backgroundTasks),
    ...(http ? { http } : {})
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
      `provider:${p.name} type=${p.type} protocol=${p.protocol} model=${p.model || "?"} env=${p.apiKeyEnv || "-"} (${p.apiKeyConfigured ? "set" : "missing"})`
    )
  }
  console.log(`check node=${report.checks.node ? "ok" : "missing"} rg=${report.checks.rg ? "ok" : "missing"} git=${report.checks.git ? "ok" : "missing"}`)
  console.log(`mcp: configured=${report.mcp.configured} healthy=${report.mcp.healthy} unhealthy=${report.mcp.unhealthy}`)
  console.log(`skills: total=${report.skills.total} template=${report.skills.template + report.skills.skillMd} mcp=${report.skills.mcpPrompt} programmable=${report.skills.programmable}`)
  console.log(`compat: ecosystems=${report.compat.ecosystems.join(",") || "-"} plugins=${report.compat.plugins} diagnostics=${report.compat.diagnostics.length}`)
  for (const item of report.compat.diagnostics.slice(0, 5)) {
    console.log(`  compat diagnostic: ${item}`)
  }
  if (report.mcp.configured === 0) {
    console.log("  mcp quickstart: kkcode mcp init --project --with-skills")
  }
  if (report.skills.total === 0) {
    console.log("  skills quickstart: kkcode skill init --project")
  }
  console.log(`sessions: ok=${report.storage.sessions.ok} index=${report.storage.sessions.sessionsInIndex} files=${report.storage.sessions.filesOnDisk}`)
  console.log(`events: active=${report.storage.eventLog.activeBytes} rotated=${report.storage.eventLog.rotatedFiles}`)
  console.log(`audit: total=${report.storage.audit.total} error1h=${report.storage.audit.error1h} error24h=${report.storage.audit.error24h} chain=${report.storage.audit.integrity.ok ? "ok" : "invalid"}`)
  console.log(
    `background: total=${report.background.total} running=${report.background.running} pending=${report.background.pending} interrupted=${report.background.interrupted} error=${report.background.error}`
  )
  if (report.http) {
    console.log("http identity:")
    for (const [name, value] of Object.entries(report.http.identity)) {
      console.log(`  ${name}: ${value}`)
    }
    for (const provider of report.http.providers) {
      console.log(`http provider:${provider.name} protocol=${provider.protocol} url=${provider.baseUrl || "(none)"} models=${provider.modelsUrl || "(none)"}`)
      if (provider.modelCatalogError) console.log(`  model catalog error: ${provider.modelCatalogError}`)
      for (const [name, value] of Object.entries(provider.headers)) {
        console.log(`  ${name}: ${value}`)
      }
    }
  }
}

export function createDoctorCommand() {
  return new Command("doctor")
    .description("run environment diagnostics")
    .option("--json", "print structured diagnostics", false)
    .option("--http", "show effective, redacted HTTP identity headers", false)
    .action(async (options) => {
      try {
        const report = await buildDoctorReport({ includeHttp: options.http })
        if (options.json) {
          console.log(JSON.stringify(report, null, 2))
          if (!report.ok) process.exitCode = 1
          return
        }
        printTextReport(report, report.themeWarnings || [])
        if (!report.ok) process.exitCode = 1
      } finally {
        McpRegistry.shutdown()
      }
    })
}
