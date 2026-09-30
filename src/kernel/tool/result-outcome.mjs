/** Pure normalization shared by the executor, direct registry calls and inline
 * background tasks. Presentation text is never the sole process evidence. */
export function normalizeToolOutcome(raw, signal = null, outputOverride = undefined) {
  const output = outputOverride ?? (typeof raw === 'string' ? raw : !raw || typeof raw !== 'object' ? String(raw ?? '')
    : typeof raw.output === 'string' ? raw.output : typeof raw.message === 'string' ? raw.message
      : typeof raw.error === 'string' ? raw.error : JSON.stringify(raw, null, 2))
  const metadata = raw?.metadata && typeof raw.metadata === 'object' ? { ...raw.metadata } : {}
  for (const key of ['exitCode', 'exitSignal', 'timedOut', 'cancelled', 'captureIncomplete', 'terminationIncomplete']) {
    if (raw && typeof raw === 'object' && raw[key] !== undefined && metadata[key] === undefined) metadata[key] = raw[key]
  }
  if (raw?.session_id || raw?.background_task_id) {
    // Successful submission/control is not a claim that the child completed.
    // Keep a small host receipt outside presentation text for every lifecycle.
    metadata.childOutcome = { status: String(raw.status || 'unknown').slice(0, 40),
      ...(raw.session_id ? { sessionId: String(raw.session_id).slice(0, 128) } : {}),
      ...(raw.background_task_id ? { backgroundTaskId: String(raw.background_task_id).slice(0, 128) } : {}),
      ...(raw.stop_reason || raw.stopReason ? { stopReason: String(raw.stop_reason || raw.stopReason).slice(0, 80) } : {}) }
  }
  if (raw?.status === 'unknown') metadata.outcomeUnknown = true
  const text = String(output || '').trim()
  let status = 'completed'
  if (signal?.aborted || raw?.cancelled === true || metadata.cancelled === true || raw?.status === 'cancelled') status = 'cancelled'
  else if (raw?.blocked === true || metadata.blocked === true || ['blocked', 'incomplete'].includes(raw?.status) || /^\[blocked\]/i.test(text)) status = 'blocked'
  else if (raw?.ok === false || ['error', 'failed', 'interrupted', 'unknown', 'partial_error'].includes(raw?.status) || raw?.is_error === true || raw?.error ||
    [raw, metadata].some(source => source?.timedOut === true || source?.captureIncomplete === true || source?.terminationIncomplete === true ||
      Number.isInteger(source?.exitCode) && source.exitCode !== 0) || /^(?:error:|\[search error\]|\[mcp error\b)/i.test(text)) status = 'error'
  const evidence = {
    ...(raw?.evidence && typeof raw.evidence === 'object' ? raw.evidence : {}),
    ...(Array.isArray(metadata.fileChanges) ? { fileChanges: metadata.fileChanges } : {}),
    ...(metadata.exitCode !== undefined ? { exitCode: metadata.exitCode } : {}),
    ...(metadata.checks !== undefined ? { checks: metadata.checks } : {}),
    ...(metadata.hashes !== undefined ? { hashes: metadata.hashes } : {})
  }
  return { status, ok: status === 'completed', output, metadata, evidence,
    code: raw?.code || (typeof raw?.error === 'string' ? raw.error : metadata.reason || (raw?.status === 'unknown' ? 'tool_outcome_unknown' : raw?.status === 'incomplete' ? 'child_incomplete' : null)),
    error: status === 'completed' ? null : typeof raw?.error === 'string' ? raw.error : raw?.error?.message || output || status }
}
