/** Run one complete case (including grading and cleanup) before starting another.
 * A delivery failure is a result. Unknown effects or an uncertain cleanup stop
 * the batch. This helper never grants model authority or resolves operations. */
export function stopReason(result) {
  if (result.controllerExit !== 0) return 'controller_or_environment_failure'
  if (result.cleanupKnown !== true) return 'cleanup_not_proven'
  if (result.usageUnknown !== 0) return 'model_usage_unknown'
  if (result.toolUnknown !== 0) return 'tool_effect_unknown'
  if (result.native?.completion?.verification?.state === 'outcome_unknown'
      || result.native?.completion?.verification?.failures?.some(item => item.kind === 'unknown_effect')) return 'tool_effect_unknown'
  if (result.state === 'environment_blocked') return 'environment_blocked'
  return null
}

export async function runSerialBatch({ sequence, before, execute, save, stopRequested = () => false }) {
  if (!Array.isArray(sequence) || !sequence.length || new Set(sequence).size !== sequence.length) throw Error('Unique nonempty sequence required')
  const state = { status: 'starting', active: null, results: [], notRun: [...sequence] }
  for (const id of sequence) {
    if (stopRequested()) {
      state.status = 'stopped'; state.reason = 'stop_requested'; break
    }
    await before(id)
    state.status = 'running'; state.active = id
    await save(structuredClone(state))
    const result = await execute(id)
    state.results.push({ id, ...result })
    state.notRun = state.notRun.filter(item => item !== id)
    state.active = null
    const reason = stopReason(result)
    if (reason) {
      state.status = 'stopped'; state.reason = reason
      await save(structuredClone(state)); return state
    }
    await save(structuredClone(state))
  }
  if (state.status !== 'stopped') state.status = 'automatic_runs_completed_manual_review_pending'
  await save(structuredClone(state))
  return state
}
