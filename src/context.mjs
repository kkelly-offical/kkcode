import { loadConfig } from "./config/load-config.mjs"
import { loadTheme } from "./theme/load-theme.mjs"
import { configureSessionStore } from "./session/store.mjs"
import { configureEventLog } from "./storage/event-log.mjs"
import { configureAuditStore } from "./storage/audit-store.mjs"
import { checkWorkspaceTrust } from "./permission/workspace-trust.mjs"
import { loadProfile } from "./onboarding.mjs"

export function applyWorkspaceTrustPolicy(configState, trustState, cwd = process.cwd()) {
  const trusted = trustState?.trusted === true
  configState.workspaceTrust = {
    cwd,
    trusted
  }
  configState.allowProjectSources = trusted
  configState.extensionConfig = trusted
    ? configState.config
    : (configState.userConfig || configState.config)
  return configState
}

export function resolveExtensionPolicy(configState) {
  const allowProjectSources = configState?.allowProjectSources !== false
  return {
    allowProjectSources,
    config: allowProjectSources
      ? (configState?.config || {})
      : (configState?.extensionConfig || configState?.userConfig || configState?.config || {})
  }
}

export async function buildContext(options = {}) {
  const configState = await loadConfig(options.cwd ?? process.cwd())

  configureSessionStore({
    sessionShardEnabled: Boolean(configState.config.storage?.session_shard_enabled ?? true),
    flushIntervalMs: Number(configState.config.storage?.flush_interval_ms ?? 1000)
  })
  configureEventLog({
    rotateMb: Number(configState.config.storage?.event_rotate_mb ?? 32),
    retainDays: Number(configState.config.storage?.event_retain_days ?? 14)
  })
  configureAuditStore({
    maxEntries: Number(configState.config.storage?.audit_max_entries ?? 5000)
  })

  const themeState = await loadTheme(configState, options.themeFile ?? null)
  const cwd = options.cwd ?? process.cwd()
  const trustState = options.trustState ?? await checkWorkspaceTrust({ cwd, cliTrust: Boolean(options.trust), isTTY: process.stdin.isTTY })
  applyWorkspaceTrustPolicy(configState, trustState, cwd)
  const profile = await loadProfile()
  return {
    configState,
    themeState,
    trustState,
    profile
  }
}

export function printContextWarnings(ctx) {
  const configErrors = ctx.configState?.errors || []
  if (configErrors.length) {
    // error 表示对应配置层未应用；别说「当前使用默认配置」，因为用户层、项目层、
    // .env 是独立的，其余已验证层仍可能生效。
    console.error("config error: 以下配置层未通过校验，已忽略；其余已验证配置继续生效")
    for (const error of configErrors) console.error(`  - ${error}`)
    console.error("  修正后重新运行；`kkcode preflight` 可复查")
  }
  const configWarnings = ctx.configState?.warnings || []
  if (configWarnings.length) {
    console.error("config warning: 以下无效配置项已忽略；同层其余配置继续生效")
    for (const warning of configWarnings) console.error(`  - ${warning}`)
    console.error("  修正后重新运行；`kkcode preflight` 可复查")
  }
  for (const error of ctx.themeState?.errors || []) {
    console.error(`theme warning: ${error}`)
  }
}
