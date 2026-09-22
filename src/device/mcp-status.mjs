const count = value => Number.isFinite(value) ? Math.max(0, Math.min(1000000, Math.floor(value))) : 0

/** Remote owners need counts/names, not MCP stderr, commands, URLs or secrets. */
export function publicMcpSummary(payload = {}) {
  const failures = Array.isArray(payload.failed) ? payload.failed : []
  const failed = failures.slice(0, 50).map(item => ({
    name: String(item?.name || 'unknown').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, '').slice(0, 128)
  }))
  return {
    ok: payload.ok === true && failures.length === 0,
    configured: count(payload.configured), connected: count(payload.connected),
    toolCount: count(payload.toolCount), promptCount: count(payload.promptCount),
    durationMs: count(payload.durationMs), background: payload.background === true,
    failed, failedCount: failures.length, truncated: failures.length > failed.length
  }
}
