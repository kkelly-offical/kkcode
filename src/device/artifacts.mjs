import { createHash } from 'node:crypto'
import { ArtifactStore, ArtifactStoreError } from '../storage/artifact-store.mjs'
import { createConversationArtifactAccess, currentArtifactAccountId, getSession, listSessions, listToolOperations, hasUnresolvedSessionRun } from '../kernel/index.mjs'
import { ProtocolError } from '../protocol/index.mjs'

export const ARTIFACT_FEATURE = 'artifacts.v1'
export const ARTIFACT_READ_METHODS = Object.freeze(['artifacts.list', 'artifacts.read', 'artifacts.search', 'artifacts.download'])
const sessionPattern = /^[A-Za-z0-9_-]{1,128}$/
const artifactPattern = /^art_[0-9a-f-]{36}$/
const hash = value => createHash('sha256').update(String(value)).digest('hex')
const failure = (code, message, status = 400) => { throw new ProtocolError(code, message, status) }
const publicItem = item => ({ id: item.id, sha256: item.sha256, size: item.size, mime: item.mime, createdAt: item.createdAt,
  source: { kind: item.source.kind }, retention: { active: item.retention.active, resolved: item.retention.resolved,
    pinned: item.retention.pinned, referenced: item.retention.references.length > 0, retired: item.retention.retired === true, updatedAt: item.retention.updatedAt } })

function boundedNumber(value, fallback, max, name) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > max) failure('artifact_invalid', `${name}超出允许范围。`)
  return value
}

/** Scope authority stays on the device. Remote parameters never contain actor,
 * workspace, account, run or filesystem path selectors. */
export class DeviceArtifacts {
  constructor(service, { storeOptions } = {}) {
    this.service = service
    this.storeOptions = storeOptions
    this.accesses = new Map()
  }

  assertActualOwner(principal) {
    this.service.assertOwner(principal)
    if (principal.id !== 'local' && (principal.actorId || principal.id) !== this.service.metadata.owner) {
      failure('forbidden', '共享会话只能查看产物，不能改变保留或清理策略。', 403)
    }
  }

  async context(sessionId) {
    if (typeof sessionId !== 'string' || !sessionPattern.test(sessionId)) failure('invalid_session', '请选择有效的会话。')
    const saved = await getSession(sessionId)
    if (!saved?.session?.cwd) failure('session_missing', '会话不存在；旧产物不会因此自动删除。', 404)
    let item = this.accesses.get(sessionId)
    if (!item || item.cwd !== saved.session.cwd) {
      item = { cwd: saved.session.cwd, access: createConversationArtifactAccess({ sessionId, cwd: saved.session.cwd,
        turnId: 'device-artifacts', storeOptions: this.storeOptions }) }
      if (this.accesses.size >= 64) this.accesses.delete(this.accesses.keys().next().value)
      this.accesses.set(sessionId, item)
    }
    return { ...item, saved }
  }

  async assertResolved(sessionId, { deleting = false } = {}) {
    const service = this.service
    if (service.turns.has(sessionId) || service.commandSessions.has(sessionId) || !deleting && service.sessionTransitions.has(sessionId)) {
      failure('artifact_busy', '会话仍在运行或切换，不能回收其证据。', 409)
    }
    if ((await listToolOperations(sessionId)).some(operation => ['pending', 'uncertain'].includes(operation.state)) || await hasUnresolvedSessionRun(sessionId)) {
      failure('artifact_unresolved', '此会话仍有未完成任务或结果未决的操作。请先核查并解决，相关证据不能清理。', 409)
    }
    for (const promise of service.kernels.values()) {
      if ((await (await promise).background?.list?.() || []).some(job => ['queued', 'running', 'pending'].includes(job.status)
        && [job.session_id, job.parent_session_id].includes(sessionId))) failure('artifact_busy', '后台任务仍在使用此会话的证据。', 409)
    }
  }

  references(saved) {
    const refs = {}
    const remember = (ref, source) => {
      if (!ref || !artifactPattern.test(ref.id) || !/^[a-f0-9]{64}$/.test(ref.sha256)) return
      const list = refs[ref.id] ||= []
      if (list.length < 1000) list.push(source)
    }
    for (const message of saved.messages || []) for (const ref of message.artifactRefs || []) remember(ref, `message_${hash(message.id)}`)
    for (const part of saved.parts || []) {
      remember(part.metadata?.artifactRef, `part_${hash(part.id)}`)
      for (const ref of Array.isArray(part.metadata?.artifactRefs) ? part.metadata.artifactRefs : []) remember(ref, `part_${hash(part.id)}`)
    }
    return refs
  }

  async prepareSessionRemoval(sessionIds) {
    const tickets = []
    for (const sessionId of sessionIds) {
      await this.assertResolved(sessionId, { deleting: true })
      const { access } = await this.context(sessionId)
      tickets.push({ sessionId, ticket: await access.prepareRetirement() })
    }
    return { commit: async deletedIds => {
      let pending = false
      for (const { sessionId, ticket } of tickets) if (deletedIds.includes(sessionId)) {
        try { await ticket.commit(); this.accesses.delete(sessionId) } catch { pending = true }
      }
      return { artifactRetirementPending: pending }
    } }
  }

  async dispatch(method, params, principal) {
    this.service.assertOwner(principal)
    const allowed = {
      'artifacts.list': ['sessionId', 'cursor', 'limit'],
      'artifacts.read': ['sessionId', 'id', 'cursor', 'limit'],
      'artifacts.download': ['sessionId', 'id', 'cursor', 'limit'],
      'artifacts.search': ['sessionId', 'id', 'query', 'cursor', 'maxMatches'],
      'artifacts.pin': ['sessionId', 'id', 'pinned'],
      'artifacts.prune': ['sessionId', 'confirmed']
    }[method]
    if (!allowed || Object.keys(params).some(key => !allowed.includes(key))) failure('artifact_invalid', '产物请求含不支持的参数；不能指定其他账号、项目、任务或主机路径。')
    if (params.cursor !== undefined && (typeof params.cursor !== 'string' || params.cursor.length > 2048)) failure('artifact_invalid', '产物分页游标无效。')
    try {
      if (!ARTIFACT_READ_METHODS.includes(method)) this.assertActualOwner(principal)
      if (method === 'artifacts.prune' && params.confirmed !== true) failure('confirmation_required', '请确认清理已到期、无引用、结果已确认的产物。固定或未决证据不会清理。', 409)
      if (method === 'artifacts.prune' && params.sessionId === undefined) {
        const accountId = await currentArtifactAccountId()
        const protectedSessions = (await listSessions({ limit: 100000, includeChildren: true })).map(session => `session_${hash(session.id)}`)
        return new ArtifactStore(this.storeOptions).pruneRetired({ accountId, protectedSessions })
      }
      const { access } = await this.context(params.sessionId)
      if (method === 'artifacts.list') {
        const page = await access.list({ cursor: params.cursor, limit: boundedNumber(params.limit, 50, 200, '列表大小') })
        return { items: page.items.map(publicItem), nextCursor: page.nextCursor }
      }
      if (method === 'artifacts.prune') {
        if (this.service.sessionTransitions.has(params.sessionId)) failure('artifact_busy', '会话正在切换或清理，请稍后重试。', 409)
        this.service.sessionTransitions.add(params.sessionId)
        try {
          // Fence new device turns BEFORE the asynchronous outcome checks.
          await this.assertResolved(params.sessionId, { deleting: true })
          // Reload after owning the transition, and preserve every canonical
          // message/part reference. Clients cannot submit their own ref counts.
          const current = await getSession(params.sessionId)
          if (!current) failure('session_missing', '会话已删除，请刷新后重试。', 404)
          await access.reconcile({ active: false, resolved: true, retired: false, references: this.references(current) })
          return await access.prune()
        } finally { this.service.sessionTransitions.delete(params.sessionId) }
      }
      if (typeof params.id !== 'string' || !artifactPattern.test(params.id)) failure('artifact_invalid', '产物 ID 无效。')
      if (method === 'artifacts.pin') {
        if (typeof params.pinned !== 'boolean') failure('artifact_invalid', '请明确指定是否固定保留产物。')
        return publicItem(await access.pin({ id: params.id, pinned: params.pinned }))
      }
      if (method === 'artifacts.search') {
        if (typeof params.query !== 'string' || !params.query.length || Buffer.byteLength(params.query) > 1024) failure('artifact_invalid', '搜索词应为 1–1024 字节的文本。')
        return await access.search({ id: params.id, query: params.query, cursor: params.cursor, maxMatches: boundedNumber(params.maxMatches, 50, 100, '结果数量'), maxBytes: 1024 * 1024 })
      }
      const page = await access.read({ id: params.id, cursor: params.cursor,
        limit: boundedNumber(params.limit, method === 'artifacts.download' ? 256 * 1024 : 16 * 1024, 256 * 1024, '读取大小') })
      const metadata = await access.metadata({ id: params.id })
      return { ...page, mime: metadata.mime, ...(method === 'artifacts.download' ? { filename: `${params.id}.txt` } : {}) }
    } catch (error) {
      if (error instanceof ProtocolError) throw error
      if (error instanceof ArtifactStoreError) throw new ProtocolError(error.code, error.message, error.status)
      throw new ProtocolError('artifact_storage_error', '产物存储或任务状态无法可靠读取，已停止操作。请在本机检查；没有自动删除或重试工具。', 409)
    }
  }
}
