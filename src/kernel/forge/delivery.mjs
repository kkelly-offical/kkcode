import { bounded, branch, number, digest, deliveryContract, deepFreeze, snapshotForgeData, fail, ForgeError } from './repository.mjs'

/**
 * A governed host service, not a model-granted capability.
 * actions.prepare(intent) -> { fresh, state, receipt? }; preparation is durable CAS.
 * actions.settle({id,state,receipt}) persists outcome. authorize(intent) returns true
 * only for a current host-issued scoped grant. Existing uncertain intents reconcile
 * read-only; even a 404 does not authorize automatic replay of an external write.
 */
export class ForgeDelivery {
  /** @param {Partial<import('../../sdk/forge.mjs').ForgeDeliveryOptions>} [options] */
  constructor({ client, contract, actions, authorize, push = null } = {}) {
    if (!client?.repository || typeof actions?.prepare !== 'function' || typeof actions?.settle !== 'function' || typeof authorize !== 'function') fail('FORGE_INVALID', '交付需要宿主模型之外的持久操作账本和授权检查。')
    this.client = Object.freeze({ repository: snapshotForgeData(client.repository), ...Object.fromEntries(
      ['validateText', 'getBranch', 'getRequest', 'listRequests', 'listComments', 'listChecks', 'reviewState', 'createDraft', 'updateDraft', 'postComment', 'markReady']
        .filter(name => typeof client[name] === 'function').map(name => [name, client[name].bind(client)])) })
    this.contract = deliveryContract(contract, this.client.repository)
    this.actions = Object.freeze({ prepare: actions.prepare.bind(actions), settle: actions.settle.bind(actions) })
    this.authorize = authorize
    this.push = push
    Object.freeze(this)
  }

  /** @param {{signal?: AbortSignal, allowMissingSource?: boolean}} [options] */
  async #pinned({ signal, allowMissingSource = false } = {}) {
    const c = this.contract
    const target = await this.client.getBranch(c.targetBranch, { signal })
    if (target !== c.targetSha) fail('FORGE_TARGET_MOVED', '目标分支已变化，请重新集成并验收后签发新的候选交付契约。')
    const source = await this.client.getBranch(c.sourceBranch, { signal, allowMissing: allowMissingSource })
    if (!allowMissingSource && source !== c.candidateSha) fail('FORGE_CANDIDATE_CHANGED', '远端任务分支不再是已验收候选，请重新核验。')
    return { target, source }
  }

  #checkRequest(request) {
    const c = this.contract
    if (request.sourceBranch !== c.sourceBranch || request.targetBranch !== c.targetBranch || request.headSha !== c.candidateSha) fail('FORGE_SCOPE', 'PR／MR 的分支或候选 SHA 与交付契约不一致。')
    if (request.state !== 'open') fail('FORGE_CLOSED', 'PR／MR 已关闭或合并，不能继续变更。')
    return request
  }

  #operation(actionId, kind, payload) {
    bounded(actionId, '操作标识', 160)
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(actionId)) fail('FORGE_INVALID', '操作标识必须为稳定的内部 ID。')
    if (!this.contract.allowedExternalActions.includes(kind)) fail('FORGE_NOT_AUTHORIZED', '该外部动作不在用户批准的任务契约内。')
    const c = this.contract
    return Object.freeze({
      id: actionId, kind, target: `${this.client.repository.webUrl}#${c.sourceBranch}`,
      parameterHash: digest({ contract: c, kind, payload }), effect: 'external_write', retryPolicy: 'reconcile'
    })
  }

  #marker(actionId) { return `<!-- kkcode-delivery:${digest([this.contract.runId, this.contract.repositoryId, actionId])} -->` }
  #evidence(kind, remoteId) { return `forge:${this.contract.repositoryId}:${kind}:${remoteId}:${this.contract.candidateSha}` }

  async #write(intent, mutate, observe, payload = {}) {
    const authorizationContext = deepFreeze({
      runId: this.contract.runId, repositoryId: this.contract.repositoryId,
      commitSha: this.contract.candidateSha, targetSha: this.contract.targetSha,
      sourceBranch: this.contract.sourceBranch, targetBranch: this.contract.targetBranch,
      payload: structuredClone(payload)
    })
    if (await this.authorize(intent, authorizationContext) !== true) fail('FORGE_GRANT_REQUIRED', '外部写入需要与本次操作参数一致且仍有效的宿主授权。')
    const existing = await this.actions.prepare(intent)
    if (!existing || typeof existing.fresh !== 'boolean' || typeof existing.state !== 'string') fail('FORGE_JOURNAL', '操作账本未返回可靠状态，写入已停止。')
    if (!existing.fresh && ['failed', 'not_applied'].includes(existing.state)) {
      return { actionId: intent.id, status: existing.state, receipt: existing.receipt || null, replayed: false }
    }
    if (existing.fresh) {
      if (existing.state !== 'prepared') fail('FORGE_JOURNAL', '新的操作意图必须先可靠记录为 prepared。')
      let allowed
      try { allowed = await this.authorize(intent, authorizationContext) }
      catch (error) {
        // Authorization/candidate inspection still precedes every external
        // effect. A thrown refusal must close the prepared intent and lease.
        await this.actions.settle({ id: intent.id, state: 'not_applied', receipt: { evidenceRefs: [], summary: '写入前授权或候选复核失败，未执行外部动作。' } })
        throw error
      }
      if (allowed !== true) {
        await this.actions.settle({ id: intent.id, state: 'not_applied', receipt: { evidenceRefs: [], summary: '写入前授权已撤销，未执行外部动作。' } })
        fail('FORGE_GRANT_REQUIRED', '写入前授权已撤销。')
      }
      try { await mutate() } catch {
        // Includes HTTP errors: never classify a write as unapplied solely from
        // a dropped reply, gateway error, or timeout. Observation decides success.
      }
    }
    try {
      const observed = await observe()
      if (observed) {
        const receipt = { evidenceRefs: [this.#evidence(intent.kind, observed.number || observed.id || 'branch')], summary: '已只读核实远端目标状态与本次操作一致。' }
        if (existing.state !== 'succeeded' || existing.fresh) await this.actions.settle({ id: intent.id, state: 'succeeded', receipt })
        return { actionId: intent.id, status: 'succeeded', result: observed, receipt, reconciled: !existing.fresh, replayed: false }
      }
    } catch { /* Incomplete reads cannot prove an external write did not happen. */ }
    if (existing.state === 'succeeded') {
      return { actionId: intent.id, status: 'changed_after_success', receipt: existing.receipt || null, replayed: false,
        message: '原操作已有成功回执，但远端当前状态已变化，未自动重放。' }
    }
    await this.actions.settle({ id: intent.id, state: 'unknown', receipt: { evidenceRefs: [], summary: '远端写入结果尚不确定，必须先核查，禁止自动重放。' } })
    return { actionId: intent.id, status: 'unknown', replayed: false, message: '外部动作结果尚不确定；保留此操作 ID 再次核查，不要创建重复动作。' }
  }

  /** @param {{actionId?: string, signal?: AbortSignal}} [options] */
  async pushCandidate({ actionId, signal } = {}) {
    if (typeof this.push !== 'function') fail('FORGE_PUSH_UNAVAILABLE', '宿主尚未配置受控 Git 推送执行器。')
    const c = this.contract
    const payload = { sourceBranch: branch(c.sourceBranch), candidateSha: c.candidateSha, refspec: `${c.candidateSha}:refs/heads/${c.sourceBranch}` }
    const intent = this.#operation(actionId, 'forge.push', payload)
    await this.#pinned({ signal, allowMissingSource: true })
    return this.#write(intent, async () => {
      await this.#pinned({ signal, allowMissingSource: true })
      await this.push({ repository: this.client.repository, ...payload, force: false, signal })
    }, async () => {
      const current = await this.#pinned({ signal })
      return current.source === c.candidateSha ? { id: c.sourceBranch, sha: current.source } : null
    }, payload)
  }

  /** @param {{actionId?: string, title?: string, body?: string, signal?: AbortSignal}} [options] */
  async openDraft({ actionId, title, body = '', signal } = {}) {
    bounded(title, '标题', 240)
    if (typeof body !== 'string' || body.length > 60_000 || body.includes('\0')) fail('FORGE_INVALID', '交付说明无效或过长。')
    this.client.validateText(title, body)
    const marker = this.#marker(actionId)
    const marked = `${body}\n\n${marker}`
    const intent = this.#operation(actionId, 'forge.draft.create', { title, body: marked })
    await this.#pinned({ signal })
    const observed = async () => {
      const requests = await this.client.listRequests({ ...this.contract, signal })
      const matches = requests.filter(request => request.body === marked && request.title.replace(/^Draft:\s*/i, '') === title.replace(/^Draft:\s*/i, ''))
      if (matches.length !== 1) return null
      const request = this.#checkRequest(matches[0])
      return request.draft ? request : null
    }
    return this.#write(intent, async () => {
      await this.#pinned({ signal })
      const requests = await this.client.listRequests({ ...this.contract, signal })
      if (requests.some(request => request.state === 'open')) return
      await this.client.createDraft({ ...this.contract, title, body: marked, signal })
    }, observed, { title, body: marked })
  }

  /** @param {{actionId?: string, number?: number, title?: string, body?: string, signal?: AbortSignal}} [options] */
  async updateDraft({ actionId, number: requestNumber, title, body = '', signal } = {}) {
    number(requestNumber); bounded(title, '标题', 240)
    if (typeof body !== 'string' || body.length > 60_000 || body.includes('\0')) fail('FORGE_INVALID', '交付说明无效或过长。')
    this.client.validateText(title, body)
    const marked = `${body}\n\n${this.#marker(actionId)}`
    const intent = this.#operation(actionId, 'forge.draft.update', { number: requestNumber, title, body: marked })
    await this.#pinned({ signal })
    return this.#write(intent, async () => {
      await this.#pinned({ signal })
      const current = this.#checkRequest(await this.client.getRequest(requestNumber, { signal }))
      if (!current.draft) fail('FORGE_NOT_DRAFT', '此请求已进入正式审查，请先由用户决定是否改回草稿。')
      await this.client.updateDraft(requestNumber, { title, body: marked, signal })
    }, async () => {
      const current = this.#checkRequest(await this.client.getRequest(requestNumber, { signal }))
      return current.draft && current.body === marked && current.title.replace(/^Draft:\s*/i, '') === title.replace(/^Draft:\s*/i, '') ? current : null
    }, { number: requestNumber, title, body: marked })
  }

  /** @param {{actionId?: string, number?: number, body?: string, signal?: AbortSignal}} [options] */
  async postComment({ actionId, number: requestNumber, body, signal } = {}) {
    number(requestNumber); bounded(body, '评论', 60_000)
    this.client.validateText(body)
    const marked = `${body}\n\n${this.#marker(actionId)}`
    const intent = this.#operation(actionId, 'forge.comment', { number: requestNumber, body: marked })
    await this.#pinned({ signal })
    this.#checkRequest(await this.client.getRequest(requestNumber, { signal }))
    return this.#write(intent, async () => {
      await this.#pinned({ signal })
      this.#checkRequest(await this.client.getRequest(requestNumber, { signal }))
      await this.client.postComment(requestNumber, { body: marked, signal })
    }, async () => {
      const matches = (await this.client.listComments(requestNumber, { signal })).filter(comment => comment.body === marked)
      return matches.length === 1 ? matches[0] : null
    }, { number: requestNumber, body: marked })
  }

  /** @param {{number?: number, signal?: AbortSignal}} [options] */
  async inspect({ number: requestNumber, signal } = {}) {
    number(requestNumber)
    const c = this.contract
    const before = await this.#pinned({ signal })
    const request = this.#checkRequest(await this.client.getRequest(requestNumber, { signal }))
    const [checks, reviews, comments] = await Promise.all([
      this.client.listChecks(c.candidateSha, { signal }), this.client.reviewState(requestNumber, { signal }), this.client.listComments(requestNumber, { signal })
    ])
    const reasons = []
    if (!c.requiredChecks.length) reasons.push('尚未明确必需 CI 检查，不能以空检查列表通过验收。')
    for (const required of c.requiredChecks) {
      const current = checks.filter(check => check.kind === required.kind && check.name === required.name &&
        (required.appId === undefined || required.appId === check.appId)).sort((a, b) => b.id - a.id)[0]
      if (!current || current.sha !== c.candidateSha || current.status !== 'success' ||
          (current.pipelineStatus !== undefined && current.pipelineStatus !== 'success')) reasons.push(`必需检查 ${required.name} 尚未在当前候选上成功。`)
    }
    if (reviews.headSha && reviews.headSha !== c.candidateSha) reasons.push('审查证据不属于当前候选。')
    if (reviews.approved < c.requiredApprovals || ['CHANGES_REQUESTED', 'REVIEW_REQUIRED', 'UNKNOWN'].includes(reviews.decision)) reasons.push('必需人工审查尚未完成或仍要求修改。')
    if (reviews.unresolved > 0 || (request.discussionsResolved === false)) reasons.push('仍有未解决的审查讨论。')
    const knownMergeState = this.client.repository.kind === 'github'
      ? request.mergeable === true && (request.draft
        ? ['clean', 'draft'].includes(request.mergeState) || reviews.mergeState === 'DRAFT'
        : request.mergeState === 'clean' && reviews.mergeState === 'CLEAN')
      : request.mergeState === 'mergeable' || (request.draft && request.mergeState === 'draft_status')
    if (!knownMergeState) reasons.push('平台尚未确认候选可以无冲突集成。')
    const after = await this.#pinned({ signal })
    const current = this.#checkRequest(await this.client.getRequest(requestNumber, { signal }))
    if (after.target !== before.target || current.draft !== request.draft) reasons.push('核验过程中远端状态变化，请重新检查。')
    return { runId: c.runId, repositoryId: c.repositoryId, number: requestNumber, candidateSha: c.candidateSha, targetSha: c.targetSha,
      status: reasons.length ? 'blocked' : request.draft ? 'ready_for_review' : 'mergeable',
      reasons, request: current, checks, reviews, comments, observedAt: new Date().toISOString(),
      canMergeAutomatically: false }
  }

  /** @param {{actionId?: string, number?: number, signal?: AbortSignal}} [options] */
  async markReady({ actionId, number: requestNumber, signal } = {}) {
    number(requestNumber)
    const intent = this.#operation(actionId, 'forge.ready', { number: requestNumber })
    const initial = await this.inspect({ number: requestNumber, signal })
    if (initial.status === 'blocked') fail('FORGE_VERIFICATION_REQUIRED', initial.reasons.join(' '))
    return this.#write(intent, async () => {
      const current = await this.inspect({ number: requestNumber, signal })
      if (current.status === 'blocked') fail('FORGE_VERIFICATION_REQUIRED', '写入前验收状态已变化，未提交就绪操作。')
      if (current.request.draft) await this.client.markReady(requestNumber, { signal })
    }, async () => {
      await this.#pinned({ signal })
      const current = this.#checkRequest(await this.client.getRequest(requestNumber, { signal }))
      return !current.draft ? current : null
    }, { number: requestNumber })
  }
}

export function createForgeDelivery(options) { return new ForgeDelivery(options) }
export { ForgeError }
