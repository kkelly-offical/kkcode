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
import { SkillRegistry } from "../skill/registry.mjs"
import { listAuthProfiles, resolveAuthProfileCredential, resolveAuthProfileStatus } from "../provider/auth-profiles.mjs"
import { getProviderSpec } from "../provider/catalog.mjs"
import { buildProviderProbeReport } from "../provider/probe.mjs"

const exec = promisify(execCb)
const TESTED_NODE_MAJORS = new Set([22])

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

function getRuntimeInfo() {
  const version = process.versions?.node || process.version || "unknown"
  const major = Number.parseInt(String(version).replace(/^v/, "").split(".")[0] || "", 10)
  const warnings = []
  if (!Number.isFinite(major) || major < 22) {
    warnings.push(`Node ${version} is below the supported baseline (>=22).`)
  } else if (!TESTED_NODE_MAJORS.has(major)) {
    warnings.push(`Node ${version} is outside the tested range (22.x).`)
  }
  if (major >= 25) {
    warnings.push(`Node ${version} runs background workers with pid/heartbeat supervision; abrupt-exit validation remains limited because node:test can hit a native child-process assertion on forced worker kill.`)
  }
  return {
    nodeVersion: version,
    nodeMajor: Number.isFinite(major) ? major : null,
    warnings
  }
}

async function buildDoctorReport() {
  const ctx = await buildContext()
  await flushNow()
  await BackgroundManager.tick(ctx.configState.config)
  const runtimeInfo = getRuntimeInfo()

  const checks = {
    node: true,
    rg: await hasCommand("rg"),
    git: await hasCommand("git")
  }

  const config = ctx.configState.config
  const authProfiles = await listAuthProfiles()
  const providers = []
  for (const [name, provider] of Object.entries(config.provider || {})) {
    if (name === "default") continue
    if (name === "strict_mode") continue
    if (name === "model_context") continue
    if (!provider || typeof provider !== "object") continue
    const keyEnv = provider.api_key_env || ""
    const providerSpec = getProviderSpec(name)
    const providerProfiles = authProfiles.filter((profile) => profile.providerId === name)
    const activeProfile = providerProfiles.find((profile) => profile.isDefault) || providerProfiles[0] || null
    const envConfigured = keyEnv ? Boolean(process.env[keyEnv]) : false
    const profileConfigured = activeProfile ? Boolean(resolveAuthProfileCredential(activeProfile)) : false
    const probe = await buildProviderProbeReport({
      configState: ctx.configState,
      providerId: name,
      model: provider.default_model || providerSpec?.default_model || null
    })
    providers.push({
      name,
      label: providerSpec?.label || name,
      type: provider.type || name,
      model: provider.default_model || null,
      baseUrl: provider.base_url || null,
      apiKeyEnv: keyEnv || null,
      authModes: providerSpec?.auth_modes || ["api_key"],
      supportsOAuth: providerSpec?.supports_oauth === true,
      apiKeyConfigured: Boolean(provider.api_key) || envConfigured || profileConfigured || provider.type === "ollama" || name === "ollama",
      authProfileCount: providerProfiles.length,
      activeAuthProfileId: activeProfile?.id || null,
      activeAuthProfileStatus: activeProfile ? resolveAuthProfileStatus(activeProfile) : null,
      credentialSource: probe.auth.credentialSource,
      warnings: probe.warnings
    })
  }

  const events = await eventLogStats()
  const audit = await auditStats()
  const storage = await fsckSessionStore()
  const backgroundTasks = await BackgroundManager.list()
  await McpRegistry.initialize(config)
  await SkillRegistry.initialize({ ...config, skills: { ...(config.skills || {}), auto_seed: false } }, process.cwd())
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
      nodeVersion: runtimeInfo.nodeVersion,
      nodeMajor: runtimeInfo.nodeMajor,
      warnings: runtimeInfo.warnings,
      authProfiles: {
        total: authProfiles.length,
        ready: authProfiles.filter((profile) => resolveAuthProfileStatus(profile) === "ready").length,
        expired: authProfiles.filter((profile) => resolveAuthProfileStatus(profile) === "expired").length
      },
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
  console.log(`node: ${report.runtime.nodeVersion}`)
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
  for (const warning of report.runtime.warnings || []) {
    console.log(`runtime warning: ${warning}`)
  }
  console.log(`auth profiles: total=${report.runtime.authProfiles.total} ready=${report.runtime.authProfiles.ready} expired=${report.runtime.authProfiles.expired}`)
  for (const p of report.runtime.providersConfigured) {
    console.log(
      `provider:${p.name} label="${p.label}" type=${p.type} model=${p.model || "?"} env=${p.apiKeyEnv || "-"} (${p.apiKeyConfigured ? "set" : "missing"}) auth=${p.authModes.join("/")} oauth=${p.supportsOAuth ? "yes" : "no"} auth_profiles=${p.authProfileCount}${p.activeAuthProfileId ? ` active=${p.activeAuthProfileId}:${p.activeAuthProfileStatus}` : ""}`
    )
    if (p.credentialSource) {
      console.log(`  credential_source=${p.credentialSource}`)
    }
    for (const warning of p.warnings || []) {
      console.log(`  warning: ${warning}`)
    }
  }
  console.log(`check node=${report.checks.node ? "ok" : "missing"} rg=${report.checks.rg ? "ok" : "missing"} git=${report.checks.git ? "ok" : "missing"}`)
  console.log(`mcp: configured=${report.mcp.configured} healthy=${report.mcp.healthy} unhealthy=${report.mcp.unhealthy}`)
  console.log(`skills: total=${report.skills.total} template=${report.skills.template + report.skills.skillMd} mcp=${report.skills.mcpPrompt} programmable=${report.skills.programmable}`)
  if (report.mcp.configured === 0) {
    console.log("  mcp quickstart: kkcode mcp init --project --with-skills")
  }
  if (report.skills.total === 0) {
    console.log("  skills quickstart: kkcode skill init --project")
  }
  console.log("  auth quickstart: kkcode auth providers")
  console.log("  auth onboarding: kkcode auth onboard openai")
  console.log("  self-hosted: kkcode auth onboard vllm --credential <api-key> --base-url http://127.0.0.1:8000/v1 --model-id <model>")
  console.log("  local proxy: kkcode auth onboard copilot-proxy --base-url http://localhost:3000/v1 --models 'gpt-5.2,claude-opus-4.6'")
  console.log("  chutes oauth: CHUTES_CLIENT_ID=... kkcode auth login chutes")
  console.log("  provider guide: kkcode init --providers")
  console.log("  auth probe: kkcode auth probe openai")
  console.log("  resume picker: kkcode session picker")
  console.log("  task center: kkcode background center")
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
