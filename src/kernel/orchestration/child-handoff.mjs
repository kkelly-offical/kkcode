/** Host-produced review locators, separate from the child's narrative. */
export function childHandoff(result, {cwd = null} = {}) {
  const files = [...new Set((result.file_changes || []).map(file => file?.path).filter(file => typeof file === 'string'))]
  const verification = result.verification
  const checks = (verification?.checks || []).slice(-8).map(check => ({label: String(check.label || '').slice(0, 120), status: check.status}))
  const blockers = (verification?.failures || []).slice(-8).map(failure => ({kind: failure.kind, ...(failure.count ? {count: failure.count} : {})}))
  return {cwd, status: result.status || 'unknown', file_count: files.length, files: files.slice(-20), checks,
    verification_state: verification?.state || 'not_verified', blockers,
    worktree: result.worktree_preserved ? {path: result.worktree_path, applied: false} : null,
    next_action: result.worktree_preserved ? 'Inspect the preserved worktree and apply through the existing controlled handoff; parent files have not been updated.'
      : ['completed', 'succeeded', 'success'].includes(result.status) ? 'Review the changed files and actual check coverage against the parent task; a child report is not final acceptance.'
        : 'Inspect retained files, checks and operation records. Use agent_followup only after deciding what further work is safe; never replay unknown effects.'}
}
