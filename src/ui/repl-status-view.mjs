import { renderStatusBar } from "../theme/status-bar.mjs"
import { normalizePermissionLevel } from "../permission/rules.mjs"
import { renderReplDashboard, renderReplLogo, renderStartupHint } from "./repl-dashboard.mjs"
import { formatRuntimeStateText } from "./repl-turn-summary.mjs"
import { renderOperatorPanel } from "./repl-operator-panel.mjs"

export function renderReplStatusLine({
  state,
  configState,
  theme,
  tokenMeter,
  cost,
  costSavings = 0,
  contextMeter = null,
  longagentState = null,
  width = null
}) {
  return renderStatusBar({
    width,
    mode: state.mode,
    modeId: state.modeId,
    model: state.model,
    permission: normalizePermissionLevel(configState.config.permission),
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
  operatorSnapshot = null,
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
    formatRuntimeStateText(state, mcpSummary, skillSummary, backgroundSummary, runtimeSummary),
    ...(operatorSnapshot ? ["", ...renderOperatorPanel(operatorSnapshot)] : [])
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
