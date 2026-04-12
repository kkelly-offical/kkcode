import { renderStatusBar } from "../theme/status-bar.mjs"
import { renderReplDashboard, renderReplLogo, renderStartupHint } from "./repl-dashboard.mjs"
import { formatRuntimeStateText } from "./repl-turn-summary.mjs"

export function renderReplStatusLine({
  state,
  configState,
  theme,
  tokenMeter,
  cost,
  costSavings = 0,
  contextMeter = null,
  longagentState = null
}) {
  return renderStatusBar({
    mode: state.mode,
    model: state.model,
    permission: configState.config.permission.default_policy,
    tokenMeter,
    aggregation: configState.config.usage.aggregation,
    cost,
    savings: costSavings,
    contextMeter,
    showCost: configState.config.ui.status.show_cost,
    showTokenMeter: configState.config.ui.status.show_token_meter,
    theme,
    layout: configState.config.ui.layout,
    longagentState: state.mode === "longagent" ? longagentState : null,
    memoryLoaded: state.memoryLoaded
  })
}

export function renderRuntimeDashboardView({
  theme,
  state,
  providers,
  recentSessions,
  mcpSummary,
  skillSummary,
  backgroundSummary,
  runtimeSummary,
  customCommandCount,
  cwd,
  columns = null
}) {
  return [
    renderReplDashboard({
      theme,
      state,
      providers,
      recentSessions,
      mcpSummary,
      skillSummary,
      backgroundSummary,
      customCommandCount,
      cwd,
      columns
    }),
    "",
    formatRuntimeStateText(state, mcpSummary, skillSummary, backgroundSummary, runtimeSummary)
  ].join("\n")
}

export function renderStartupScreen({ theme, recentSessions, columns = null }) {
  const logo = renderReplLogo({ theme, columns })
  const hint = renderStartupHint(recentSessions)
  return hint ? `${logo}\n${hint}\n` : logo
}

export function renderFrameDashboardHeader({ showDashboard, theme, columns = null }) {
  if (!showDashboard) return []
  return renderReplLogo({ theme, columns }).split("\n")
}
