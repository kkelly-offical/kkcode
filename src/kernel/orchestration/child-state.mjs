import { getSession, updateSessionIf } from '../session/store.mjs'
import { publicContext } from '../../protocol/context.mjs'

const text = (value, max = 160) => typeof value === 'string' ? value.slice(0, max) : ''

export async function updateChildOperation(sessionId, operationId, patch) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const session = (await getSession(sessionId))?.session
    if (!session || session.childOperationId !== operationId) return null
    const updated = await updateSessionIf(sessionId, { childOperationId: operationId, childRevision: session.childRevision }, {
      ...patch, childRevision: (session.childRevision || 0) + 1, childUpdatedAt: Date.now()
    })
    if (updated) return updated
  }
  throw new Error('Child status changed repeatedly; inspect its current state')
}

export function settleChildOperation(sessionId, operationId, result) {
  return updateChildOperation(sessionId, operationId, {
    childOperationId: null, childSettledOperationId: operationId, childStatus: result.status,
    childResult: result, childSettledAt: Date.now()
  })
}

/** Same-parent presentation only: no prompt, result text, credentials or policy. */
export function childSnapshot(session, status = session.childStatus || 'unknown') {
  const runtime = session.childRuntime || {}, progress = session.childProgress || {}
  return { session_id: session.id, parent_session_id: session.childContract.parentSessionId,
    subagent: text(session.childContract.runSpec?.role?.name) || 'unknown', status,
    description: text(session.childDescription), model: text(runtime.model || session.childContract.runSpec?.model),
    provider: text(runtime.provider || session.childContract.runSpec?.provider),
    revision: session.childRevision || 0, started_at: session.childStartedAt || null, updated_at: session.childUpdatedAt || null,
    settled_at: session.childSettledAt || null, background_task_id: session.childBackgroundTaskId || null,
    pending_messages: session.childMailbox?.length || 0, context: publicContext(session.context),
    runtime: { thinking: text(runtime.thinking), output_reserved: Number.isSafeInteger(runtime.output_reserved) ? runtime.output_reserved : null,
      context_limit: Number.isSafeInteger(runtime.context_limit) ? runtime.context_limit : null },
    activity: { phase: session.childStopRequestedAt && ['running', 'pending'].includes(status) ? 'stopping' : text(progress.phase, 40), tool: text(progress.tool, 80), step: Number.isSafeInteger(progress.step) ? progress.step : null }
  }
}
