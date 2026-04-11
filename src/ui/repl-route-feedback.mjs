function formatModeLabel(mode) {
  return mode === "ask" ? "ask（问答）" : String(mode || "agent")
}

export function buildRouteFeedback({ route, currentMode, routeSummary = "" } = {}) {
  if (!route) {
    return {
      changedMessage: null,
      forcedMessage: null,
      suggestionMessage: null,
      stayedMessage: null,
      summaryMessage: null
    }
  }

  const routeExplanation = route.explanation || route.reason || ""

  return {
    changedMessage: route.changed
      ? `⟳ 自动切换到 ${formatModeLabel(route.mode)} 模式（${routeExplanation}）`
      : null,
    forcedMessage: route.forced && route.suggestion
      ? `⚠ 这看起来是个简单任务（${routeExplanation}），建议用 ${route.suggestion} 模式。输入 y 继续用 longagent，或 n 切换到 ${route.suggestion}。`
      : null,
    suggestionMessage: route.suggestion === "longagent" && currentMode === "agent"
      ? `💡 这看起来是个复杂任务（${routeExplanation}），可以用 /longagent 切换到 longagent 模式获得更好效果。`
      : null,
    stayedMessage: !route.changed && !route.suggestion && !(route.forced && route.suggestion) && route.reason !== "low_confidence"
      ? `↳ 保持 ${formatModeLabel(currentMode)} 模式（${routeExplanation}）`
      : null,
    summaryMessage: routeSummary ? `   ${routeSummary}` : null
  }
}
