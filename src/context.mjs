import { loadConfig } from "./config/load-config.mjs"
import { loadTheme } from "./theme/load-theme.mjs"
import { configureSessionStore } from "./kernel/session/store.mjs"
import { configureEventLog } from "./storage/event-log.mjs"
import { configureAuditStore } from "./storage/audit-store.mjs"
import { checkWorkspaceTrust } from "./kernel/permission/workspace-trust.mjs"
import { PermissionEngine } from "./kernel/permission/engine.mjs"
import { ToolRegistry } from "./kernel/tool/registry.mjs"
import { SkillRegistry } from "./kernel/skill/registry.mjs"
import { CustomAgentRegistry } from "./kernel/agent/custom-agent-loader.mjs"
import { initHookBus } from "./kernel/plugin/hook-bus.mjs"
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

// 内核 boot 序列的唯一归属（1.0.0 阶段 1a）：原先 6+ 个入口各自复制这段初始化，
// 顺序漂移互不感知。所有入口改调本函数；初始化顺序逐字保持现状：
// PermissionEngine.setTrusted → ToolRegistry → SkillRegistry → CustomAgentRegistry → initHookBus。
//
// 阶段 2a 起接受可选的 `registries`：createKernel 把自己实例化出来的注册表传进来，
// boot 序列作用于 kernel 实例字段而非进程级默认单例；缺省（registries 为空）时
// 行为与之前完全一致（旧入口的兼容路径）。
export async function bootstrapKernelExtensions({ cwd, configState, trustState, registries = null }) {
  const permissionEngine = registries?.permissions ?? PermissionEngine
  const toolRegistry = registries?.tools ?? ToolRegistry
  const skillRegistry = registries?.skills ?? SkillRegistry
  permissionEngine.setTrusted(trustState?.trusted === true)
  const extensionPolicy = resolveExtensionPolicy(configState)
  await toolRegistry.initialize({
    config: extensionPolicy.config,
    cwd,
    allowProjectSources: extensionPolicy.allowProjectSources
  })
  await skillRegistry.initialize(extensionPolicy.config, cwd, {
    allowProjectSources: extensionPolicy.allowProjectSources
  })
  await CustomAgentRegistry.initialize(cwd, {
    allowProjectSources: extensionPolicy.allowProjectSources,
    config: extensionPolicy.config
  })
  if (registries?.hooks) {
    await registries.hooks.initialize(cwd, extensionPolicy.config, {
      allowProjectSources: extensionPolicy.allowProjectSources
    })
  } else {
    await initHookBus(cwd, extensionPolicy.config, {
      allowProjectSources: extensionPolicy.allowProjectSources
    })
  }
  return extensionPolicy
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
    // Invalid security policy is deliberately retained as deny-all, not ignored.
    console.error("config error: 以下配置未通过校验；无效普通项已忽略，安全限制可能按拒绝策略保留，其余已验证配置继续生效")
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
