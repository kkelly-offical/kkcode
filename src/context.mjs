import { loadConfig } from "./config/load-config.mjs"
import { loadTheme } from "./theme/load-theme.mjs"
import { configureSessionStore } from "./session/store.mjs"
import { configureEventLog } from "./storage/event-log.mjs"
import { configureAuditStore } from "./storage/audit-store.mjs"
import { checkWorkspaceTrust } from "./permission/workspace-trust.mjs"

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
  const trustState = await checkWorkspaceTrust({ cwd, cliTrust: Boolean(options.trust), isTTY: process.stdin.isTTY })
  return {
    configState,
    themeState,
    trustState
  }
}

export function printContextWarnings(ctx) {
  for (const error of ctx.configState.errors) {
    console.error(`config warning: ${error}`)
  }
  for (const error of ctx.themeState.errors) {
    console.error(`theme warning: ${error}`)
  }
}
