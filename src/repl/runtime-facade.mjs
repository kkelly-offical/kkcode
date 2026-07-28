import { listSessions } from "../session/store.mjs"
import { BackgroundManager } from "../orchestration/background-manager.mjs"
import { summarizeSessionRuntimeState } from "../session/runtime-state.mjs"
import { collectMcpSummary, collectSkillSummary } from "./state-store.mjs"
import { inspectSandboxStatus } from "../tool/sandbox.mjs"

export async function buildReplRuntimeSnapshot({
  cwd = process.cwd(),
  state,
  customCommands = [],
  providers = [],
  mcpRegistry,
  skillRegistry,
  recoveryEnabled = true,
  config = null
}) {
  const recentSessions = await listSessions({ cwd, limit: 6, includeChildren: false }).catch(() => [])
  const mcpSummary = collectMcpSummary(mcpRegistry)
  const skillSummary = collectSkillSummary(skillRegistry)
  const backgroundSummary = await BackgroundManager.summary().catch(() => null)
  const runtimeSummary = await summarizeSessionRuntimeState({
    sessionId: state?.sessionId || null,
    cwd,
    recoveryEnabled
  }).catch(() => null)
  // 沙箱是「开了但没生效」最容易发生的那类设置：面板得说真实后端，
  // 不是复述配置里写了什么
  const sandboxStatus = await inspectSandboxStatus(config).catch(() => null)

  return {
    state,
    sandboxStatus,
    providers,
    recentSessions,
    mcpSummary,
    skillSummary,
    backgroundSummary,
    runtimeSummary,
    customCommandCount: customCommands.length,
    cwd
  }
}
