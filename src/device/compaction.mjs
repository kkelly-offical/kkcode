import { randomUUID } from 'node:crypto'
import { ProtocolError } from '../protocol/index.mjs'
import { requestContextBudget } from '../kernel/session/context-budget.mjs'
import { getSession } from '../kernel/session/store.mjs'
import { awaitAbortable } from '../abort.mjs'

/** A manual compact is a cancellable operation owned by the same turn broker. */
/** @param {{service: any, kernel?: any, sessionId: string, state?: any, principal: any, executionId?: string}} options */
export async function startDeviceCompaction({ service, kernel, sessionId, state, principal, executionId }) {
  if (executionId !== undefined && (typeof executionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(executionId))) throw new ProtocolError('invalid_turn', '回合标识无效，请重试。')
  const snapshot = await (kernel ? kernel.sessions.getSession(sessionId) : getSession(sessionId))
  if (!snapshot) throw new ProtocolError('session_missing', 'Session not found', 404)
  if (snapshot.session.archived) throw new ProtocolError('session_archived', '恢复归档后再压缩上下文。', 409)
  service.lease(sessionId, principal)
  if (service.turns.has(sessionId)) throw new ProtocolError('turn_busy', 'Wait for the active operation to finish', 409)
  const turnId = executionId || randomUUID(), controller = new AbortController()
  const entry = { controller, turnId, origin: 'remote', client: principal.client, phase: 'compacting', operation: 'compact' }
  service.turns.set(sessionId, entry)
  entry.promise = Promise.resolve().then(async () => {
    controller.signal.throwIfAborted()
    await service.record({ type: 'session.compacting', sessionId, turnId, payload: { operation: 'compact' } })
    kernel ||= await awaitAbortable(service.kernel(snapshot.session.cwd), controller.signal)
    await awaitAbortable(kernel.bootExtensions(), controller.signal)
    if (!state) {
      const saved = { ...snapshot.session, ...service.commandStates.get(sessionId) }, config = kernel.configState.config
      const providerType = saved.providerType || config.provider.default
      state = { providerType, model: saved.model || config.provider[providerType]?.default_model || '' }
    }
    controller.signal.throwIfAborted()
    const result = await kernel.run(() => kernel.sessions.compactSession({
      sessionId, turnId, model: state.model, providerType: state.providerType,
      configState: kernel.configState, force: true, signal: controller.signal
    }))
    if (!result.compacted) {
      controller.signal.throwIfAborted()
      throw new ProtocolError('compaction_skipped', `未压缩：${result.reason || '当前上下文无需压缩'}。原对话已保留。`)
    }
    // The history commit has succeeded. A stop racing this point must report
    // the committed result, not claim cancellation/rollback after success.
    entry.committed = true
    const saved = await kernel.sessions.getSession(sessionId)
    const context = requestContextBudget({ messages: saved.messages, model: state.model, providerType: state.providerType, configState: kernel.configState })
    const prior = snapshot.session.context
    // Reuse known instruction/schema overhead only for the same route. This
    // is explicitly an estimate; the next request still builds a fresh budget.
    if (prior?.model === state.model && prior?.provider === state.providerType) {
      for (const key of ['system', 'tools']) context.components[key] = Math.max(0, Number(prior.components?.[key]) || 0)
      context.tokens = Object.values(context.components).reduce((sum, value) => sum + value, 0)
      context.requiredTokens = context.tokens + context.outputReserved
      context.percent = Math.min(100, Math.round(context.tokens * 100 / context.limit))
      context.ratio = Math.min(1, context.tokens / context.limit)
    }
    const compaction = { ...result, beforeTokens: prior?.tokens ?? result.estimatedBeforeTokens, afterTokens: context.tokens, limit: context.limit, source: 'estimated', compactedAt: Date.now() }
    await kernel.sessions.updateSession(sessionId, { context, lastCompaction: compaction })
    await service.record({ type: 'session.context.updated', sessionId, turnId, payload: { context } })
    await service.record({ type: 'session.compacted', sessionId, turnId, payload: compaction })
    return { operation: 'compact', compaction }
  }).then(result => service.settleTurn(sessionId, entry, { result }), error => service.settleTurn(sessionId, entry, { error }))
  entry.promise.catch(() => {})
  return { accepted: true, turnId, executionId: turnId, operation: 'compact' }
}
