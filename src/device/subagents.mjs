import { getSession } from '../kernel/session/store.mjs'
import { createChildController, listChildSnapshots, ownedChild } from '../kernel/orchestration/child-controller.mjs'
import { updateChildOperation } from '../kernel/orchestration/child-state.mjs'
import { ProtocolError } from '../protocol/index.mjs'

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
export const SUBAGENT_FEATURE = 'subagents.v1'

export async function dispatchSubagents(service, method, params, principal) {
  service.assertOwner(principal)
  const owner = service.metadata.owner
  const fields = method === 'subagents.list' ? ['sessionId'] : ['sessionId', 'childSessionId']
  if (!['subagents.list', 'subagents.interrupt'].includes(method) || Object.keys(params).some(key => !fields.includes(key))
      || !id(params.sessionId) || method === 'subagents.interrupt' && !id(params.childSessionId)) throw new ProtocolError('subagent_invalid', '请选择当前会话的子代理。')
  if (!(await getSession(params.sessionId))) throw new ProtocolError('session_missing', '会话不存在。', 404)
  if (method === 'subagents.interrupt') {
    if (principal.id !== 'local' && (principal.actorId || principal.id) !== owner) throw new ProtocolError('forbidden', '只有设备所有者可以停止子代理。', 403)
    service.lease(params.sessionId, principal)
    const child = await ownedChild(params.sessionId, params.childSessionId)
    service.assertOwner(principal)
    if (service.metadata.owner !== owner) throw new ProtocolError('subagent_scope_changed', '设备归属已改变。', 409)
    if (child.childOperationId) await updateChildOperation(params.childSessionId, child.childOperationId, { childCancelledByUserAt: Date.now(), childStopRequestedAt: Date.now() })
    await createChildController({ parentSessionId: params.sessionId }).interrupt(params.childSessionId)
  }
  const items = await listChildSnapshots(params.sessionId)
  service.assertOwner(principal)
  if (service.metadata.owner !== owner) throw new ProtocolError('subagent_scope_changed', '设备归属已改变，请重新连接。', 409)
  return { sessionId: params.sessionId, items }
}
