import { deliveryContract, branch, bounded, number, digest, fail, snapshotForgeData } from './repository.mjs'

/** Original-action observation only. Never calls prepare/authorize/mutation,
 * does not require an unchanged current worktree, and cannot mint an intent. */
export function createForgeReconciler({ client, contract: input, actions }) {
  if (typeof actions?.lookup !== 'function' || typeof actions?.settle !== 'function') fail('FORGE_JOURNAL', '只读核查需要绑定原持久意图的宿主账本。')
  const contract = deliveryContract(input, client.repository)
  return Object.freeze({ async reconcile({ operation, request, signal }) {
    request = snapshotForgeData(request)
    const kinds = { push: 'forge.push', draft: 'forge.draft.create', update: 'forge.draft.update', comment: 'forge.comment', ready: 'forge.ready' }
    const kind = kinds[operation]
    if (!kind || !request || !contract.allowedExternalActions.includes(kind)) fail('FORGE_INVALID', '不能识别原始交付操作。')
    const id = bounded(request.actionId, '操作标识', 160)
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id)) fail('FORGE_INVALID', '操作标识无效。')
    const marker = `<!-- kkcode-delivery:${digest([contract.runId, contract.repositoryId, id])} -->`
    let payload
    if (operation === 'push') payload = { sourceBranch: branch(contract.sourceBranch), candidateSha: contract.candidateSha, refspec: `${contract.candidateSha}:refs/heads/${contract.sourceBranch}` }
    else {
      if (['update', 'comment', 'ready'].includes(operation)) number(request.number)
      if (['draft', 'update'].includes(operation)) bounded(request.title, '原始标题', 240)
      if (['draft', 'update', 'comment'].includes(operation)) {
        if (typeof (request.body ?? '') !== 'string' || (request.body || '').length > 60000) fail('FORGE_INVALID', '原始交付正文无效。')
        client.validateText(request.body || '', request.title || '')
      }
      payload = { ...(['update', 'comment', 'ready'].includes(operation) ? { number: request.number } : {}),
        ...(['draft', 'update'].includes(operation) ? { title: request.title } : {}),
        ...(['draft', 'update', 'comment'].includes(operation) ? { body: `${request.body || ''}\n\n${marker}` } : {}) }
    }
    const intent = { id, kind, target: `${client.repository.webUrl}#${contract.sourceBranch}`, parameterHash: digest({ contract, kind, payload }), effect: 'external_write', retryPolicy: 'reconcile' }
    const existing = await actions.lookup(intent)
    if (!existing) fail('FORGE_INTENT_MISSING', '没有精确匹配的原始意图；只读核查不会创建或执行新操作。')
    const observation = { replayed: false, readOnly: true, candidateRevalidated: false, requiresReverification: true }
    if (['not_applied', 'failed'].includes(existing.state)) return { actionId: id, status: existing.state, receipt: existing.receipt, ...observation }
    let observed = null, targetChanged = false
    const matches = item => item.sourceBranch === contract.sourceBranch && item.targetBranch === contract.targetBranch && item.headSha === contract.candidateSha
    try {
      targetChanged = await client.getBranch(contract.targetBranch, { signal }) !== contract.targetSha
      if (operation === 'push') {
        if (await client.getBranch(contract.sourceBranch, { signal, allowMissing: true }) === contract.candidateSha) observed = { id: contract.sourceBranch, sha: contract.candidateSha }
      } else if (operation === 'draft') {
        const items = (await client.listRequests({ sourceBranch: contract.sourceBranch, targetBranch: contract.targetBranch, signal }))
          .filter(item => matches(item) && item.state === 'open' && item.draft && item.body === payload.body && item.title.replace(/^Draft:\s*/i, '') === payload.title.replace(/^Draft:\s*/i, ''))
        if (items.length === 1) observed = items[0]
      } else {
        const item = await client.getRequest(request.number, { signal })
        if (matches(item)) {
          if (operation === 'ready' && item.state === 'open' && !item.draft) observed = item
          else if (operation === 'update' && item.state === 'open' && item.draft && item.body === payload.body && item.title.replace(/^Draft:\s*/i, '') === payload.title.replace(/^Draft:\s*/i, '')) observed = item
          else if (operation === 'comment') {
            const notes = (await client.listComments(request.number, { signal })).filter(comment => comment.body === payload.body)
            if (notes.length === 1) observed = notes[0]
          }
        }
      }
    } catch { /* Failed/incomplete reads never prove that a write did not happen. */ }
    if (existing.state === 'succeeded') return { actionId: id, status: observed ? 'succeeded' : 'changed_after_success', result: observed, receipt: existing.receipt, ...observation, targetChanged }
    const state = observed ? 'succeeded' : 'unknown'
    const receipt = { evidenceRefs: observed ? [`forge:${contract.repositoryId}:${kind}:${observed.number || observed.id || 'branch'}:${contract.candidateSha}`] : [],
      summary: observed ? `已只读核实原始操作目标状态；此回执不重新验证当前候选。${targetChanged ? '目标分支已变化，交付仍须重新验收。' : ''}` : '只读核查仍无法确认原始操作结果，未重放。' }
    await actions.settle({ id, state, receipt })
    return { actionId: id, status: state, result: observed, receipt, ...observation, targetChanged }
  } })
}
