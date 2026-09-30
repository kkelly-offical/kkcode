import { getSession } from '../kernel/index.mjs'
import { readTodoSnapshot } from '../kernel/session/todo-state.mjs'
import { ProtocolError } from '../protocol/index.mjs'

export const TODO_FEATURE = 'todos.v1'
export const TODO_READ_METHODS = Object.freeze(['todos.list'])

/** Deliberately read-only. RPC/remote clients cannot author progress, change an
 * item's owner, supply an arbitrary verified flag, or reference another session. */
export class DeviceTodos {
  constructor(service) { this.service = service }
  async dispatch(method, params, principal) {
    this.service.assertOwner(principal)
    const owner = this.service.metadata.owner
    if (method !== 'todos.list' || !params || typeof params !== 'object' || Array.isArray(params)
        || Object.keys(params).some(key => key !== 'sessionId') || typeof params.sessionId !== 'string'
        || !/^[A-Za-z0-9_-]{1,128}$/.test(params.sessionId)) throw new ProtocolError('todo_invalid', '请选择当前会话；任务列表不能指定其他账号、工作区或验证状态。')
    const saved = await getSession(params.sessionId)
    if (!saved) throw new ProtocolError('session_missing', '任务会话不存在，请刷新会话列表。', 404)
    const snapshot = readTodoSnapshot(saved.parts, params.sessionId)
    this.service.assertOwner(principal)
    if (this.service.metadata.owner !== owner) throw new ProtocolError('todo_scope_changed', '读取期间设备所有者已经变化，请刷新后重试。', 409)
    return snapshot
  }
}
