import { listSessions } from "../session/store.mjs"
import { BackgroundManager } from "../orchestration/background-manager.mjs"
import { summarizeSessionRuntimeState } from "../session/runtime-state.mjs"
import { collectMcpSummary, collectSkillSummary } from "./state-store.mjs"

export async function buildReplRuntimeSnapshot({
  cwd = process.cwd(),
  state,
  customCommands = [],
  providers = [],
  mcpRegistry,
  skillRegistry,
  recoveryEnabled = true
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

  return {
    state,
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
