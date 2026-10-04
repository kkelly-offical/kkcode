/** Display the most recent measured input while a newer request is only an
 * estimate. This never changes the fresh budget used for admission/compaction. */
export function contextDisplay(preflight, measured = null) {
  if (preflight?.source !== 'estimated' || measured?.source !== 'provider-usage' ||
      !Number.isFinite(measured.tokens) || measured.tokens < 0 ||
      measured.model !== preflight.model || measured.provider !== preflight.provider || measured.limit !== preflight.limit ||
      (measured.routeScope || null) !== (preflight.routeScope || null)) return preflight
  return { ...measured, outputReserved: preflight.outputReserved, inputBudget: preflight.inputBudget,
    windowKind: preflight.windowKind, contextSource: preflight.contextSource, outputSource: preflight.outputSource,
    requiredTokens: measured.tokens + (preflight.windowKind === 'input' ? 0 : preflight.outputReserved) }
}
