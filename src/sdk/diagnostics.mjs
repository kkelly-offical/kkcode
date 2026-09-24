/** Read-only diagnosis from canonical host records. No prompt bodies, command
 * arguments, credentials, filesystem roots, or authorization artifacts leave it. */
export async function diagnoseRun({ store, runId }) {
  const run = await store.getRun(runId), blockers = [], active = !['completed', 'cancelled'].includes(run.state)
  const unresolved = run.actions.filter(action => ['prepared', 'unknown'].includes(action.state))
  if (unresolved.length) blockers.push({ code: 'effects_unresolved', count: unresolved.length, message: '有待回执或未知副作用。先核查结果，不要重新执行同一操作。' })
  if (run.lastTurn?.status === 'running') blockers.push({ code: 'turn_active', count: 1, message: '执行器仍在运行或收尾；暂停/取消请求不等于操作已停止。' })
  const budget = run.budget ?? await store.getRunBudget?.({ runId }) ?? null
  if (!budget && active) blockers.push({ code: 'budget_missing', count: 1, message: '尚未确认持久预算，不能授权新的模型调用。' })
  if (budget) {
    if (budget.requests.some(request => request.status === 'unknown')) blockers.push({ code: 'billing_unknown', count: budget.requests.filter(request => request.status === 'unknown').length, message: '计费结果待核查。未知金额仍占预留上界，不会自动补零或释放额度。' })
    if (active && Date.now() >= budget.deadlineAt) blockers.push({ code: 'deadline_expired', count: 1, message: '任务固定期限已过，不会静默延长。' })
    if (active && (budget.budgetUsd === 0 || budget.spentUsd + budget.reservedUsd + budget.unknownUsd >= budget.budgetUsd)) blockers.push({ code: 'budget_exhausted', count: 1, message: '没有可供新请求使用的已批准预算。' })
  }
  const criteria = run.contract.requiredCriteria.map(criterion => {
    const receipt = run.verifications.filter(value => value.criterionId === criterion.id && value.candidateHash === run.candidateHash && value.candidateGeneration === run.candidateGeneration && value.contractVersion === run.contractVersion).at(-1)
    return { id: criterion.id, status: receipt?.status === 'passed' && !receipt.evidenceRefs?.length ? 'unknown' : receipt?.status || 'unknown' }
  })
  if (!run.candidateHash) blockers.push({ code: 'candidate_missing', count: 1, message: '尚无封存候选，不能把模型结论视为交付。' })
  if (!criteria.length || criteria.some(criterion => criterion.status !== 'passed')) blockers.push({ code: 'verification_incomplete', count: criteria.filter(criterion => criterion.status !== 'passed').length || 1, message: '当前候选的必需验收未全部通过；缺失/旧版本/无证据不算通过。' })
  const graphs = await store.listTaskGraphs?.({ runId }) || []
  const pendingGraphs = graphs.filter(graph => !['accepted', 'cancelled'].includes(graph.status))
  if (pendingGraphs.length) blockers.push({ code: 'delegation_unresolved', count: pendingGraphs.length, message: '子任务图仍有待核准、运行中或待核查结果。' })
  return { schemaVersion: 1, runId: run.id, revision: run.revision, state: run.state, candidateHash: run.candidateHash,
    blockers, criteria, note: '只读诊断，不核发授权、不执行或重放动作；通过结构检查也不能代替独立执行验收。' }
}
export async function diagnoseKernel({ kernel, sessionId }) {
  return { schemaVersion: 1, services: kernel.diagnostics.services?.() || [],
    prompt: sessionId ? await kernel.diagnostics.inspectPrompt(sessionId) : null,
    note: '配置就绪不等于后端已实测。提示诊断仅包含来源/指纹/预算元数据，不是完整提示词。' }
}
