import { randomUUID } from 'node:crypto'
import { createMemoryController, MemoryError, getSession } from '../kernel/index.mjs'
import { resolveDevicePath } from './files.mjs'
import { ProtocolError } from '../protocol/index.mjs'

export const MEMORY_FEATURE = 'memory.v1'
export const MEMORY_READ_METHODS = Object.freeze(['memory.list', 'memory.get', 'memory.legacy'])
export const MEMORY_METHODS = Object.freeze([...MEMORY_READ_METHODS, 'memory.propose', 'memory.correct', 'memory.confirm', 'memory.enable', 'memory.forget', 'memory.observe', 'memory.import'])
const fail = (code, message, status = 400) => { throw new ProtocolError(code, message, status) }
const fields = {
  'memory.list': ['includeCandidates', 'includeDisabled'], 'memory.get': ['id'],
  'memory.propose': ['text', 'category'], 'memory.correct': ['id', 'expectedVersion', 'text'],
  'memory.confirm': ['id', 'expectedVersion', 'confirmed'], 'memory.enable': ['id', 'expectedVersion', 'enabled', 'confirmed'],
  'memory.forget': ['id', 'expectedVersion', 'confirmed'], 'memory.observe': [],
  'memory.legacy': [], 'memory.import': ['source', 'confirmed']
}

/** Owner-only host RPC facade, deliberately not registered as a model tool.
 * Browser/App confirmation comes from an authenticated owner action and CAS,
 * never from a proposed memory's JSON or imported confidence value. */
export class DeviceMemory {
  constructor(service) { this.service = service }
  assertOwner(principal) {
    this.service.assertOwner(principal)
    if (principal.id !== 'local' && (principal.actorId || principal.id) !== this.service.metadata.owner) fail('forbidden', '记忆属于设备所有者，共享访客不能读取或修改。', 403)
  }
  async dispatch(method, params, principal) {
    try { return await this.handle(method, params, principal) }
    catch (error) { if (error instanceof MemoryError) throw new ProtocolError(error.code, error.message, error.status); throw error }
  }
  async handle(method, params, principal) {
    this.assertOwner(principal)
    if (!Object.hasOwn(fields, method) || !params || typeof params !== 'object' || Array.isArray(params)
      || Object.keys(params).some(key => !['scope', 'sessionId', ...fields[method]].includes(key))) fail('memory_invalid', '记忆请求含不支持的参数，不能指定其他账号或主机路径。')
    const scope = params.scope ?? 'project'
    if (!['project', 'personal'].includes(scope)) fail('memory_invalid_scope', '记忆范围无效。')
    if (scope === 'personal' && ['memory.observe', 'memory.import', 'memory.legacy'].includes(method)) fail('memory_invalid_scope', '项目观察和旧文件迁移只能用于项目记忆。')
    if (this.service.workspaceMutation || this.service.configurationUpdating || this.service.closed) fail('device_busy', '设备维护或关闭中，请稍后再管理记忆。', 409)
    let cwd = this.service.cwd
    if (params.sessionId !== undefined) {
      if (typeof params.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(params.sessionId)) fail('invalid_session', '请选择有效会话。')
      const saved = await getSession(params.sessionId)
      if (!saved?.session?.cwd) fail('session_missing', '会话不存在。', 404)
      cwd = saved.session.cwd
    } else if (scope === 'project') fail('invalid_session', '项目记忆需要当前会话。')
    cwd = await resolveDevicePath(cwd, this.service.roots, { directory: true })
    const needsConfirmation = ['memory.confirm', 'memory.forget', 'memory.import'].includes(method) || method === 'memory.enable' && params.enabled === true
    if (needsConfirmation && params.confirmed !== true) fail('confirmation_required', '请在记忆管理界面查看具体内容后明确确认。', 409)
    for (const flag of ['includeCandidates', 'includeDisabled', 'confirmed']) if (params[flag] !== undefined && typeof params[flag] !== 'boolean') fail('memory_invalid', '记忆请求中的开关必须为布尔值。')
    const memory = createMemoryController({ cwd, confirmMemory: async request => {
      this.assertOwner(principal)
      if (!needsConfirmation || params.confirmed !== true || request.scope !== scope) return { approved: false }
      if (request.action === 'memory.confirm' && (request.entry.id !== params.id || request.entry.version !== params.expectedVersion)) return { approved: false }
      if (request.action === 'memory.import-legacy' && request.source !== params.source) return { approved: false }
      return { approved: true, confirmedBy: principal.actorId || principal.id, approvalId: `memory-owner-action-${randomUUID()}` }
    } })
    const key = { scope, id: params.id, expectedVersion: params.expectedVersion }
    if (method === 'memory.list') return memory.list({ scope, includeCandidates: params.includeCandidates, includeDisabled: params.includeDisabled })
    if (method === 'memory.get') return memory.get(key)
    if (method === 'memory.legacy') return memory.legacySources()
    let result
    if (method === 'memory.propose') result = await memory.propose({ scope, text: params.text, category: params.category, sessionId: params.sessionId })
    else if (method === 'memory.correct') result = await memory.correct({ ...key, text: params.text })
    else if (method === 'memory.confirm') result = await memory.confirm(key)
    else if (method === 'memory.enable') result = await memory.setEnabled({ ...key, enabled: params.enabled })
    else if (method === 'memory.forget') result = await memory.forget(key)
    else if (method === 'memory.observe') result = await memory.observeProject({ sessionId: params.sessionId })
    else if (method === 'memory.import') result = await memory.importLegacy({ source: params.source })
    this.service.emitDeviceEvent?.('memory.updated', { scope, sessionId: params.sessionId || null })
    return result
  }
}
