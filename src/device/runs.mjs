import path from 'node:path'
import { access } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { openRunStore, ArtifactStore, currentArtifactAccountId, getSession, RUN_STATES } from '../kernel/index.mjs'
import { userRootDir } from '../storage/paths.mjs'
import { ProtocolError } from '../protocol/index.mjs'

export const RUN_FEATURE = 'runs.v1'
export const RUN_READ_METHODS = Object.freeze(['runs.list', 'runs.get', 'runs.events', 'runs.artifacts.list', 'runs.artifacts.read', 'runs.artifacts.download'])
const fields = {
  'runs.list': ['sessionId', 'cursor', 'limit'], 'runs.get': ['sessionId', 'runId'],
  'runs.events': ['sessionId', 'runId', 'after', 'limit'],
  'runs.pause': ['sessionId', 'runId', 'expectedRevision', 'expectedOwnerEpoch', 'confirmed'],
  'runs.cancel': ['sessionId', 'runId', 'expectedRevision', 'expectedOwnerEpoch', 'confirmed'],
  'runs.artifacts.list': ['sessionId', 'runId', 'cursor', 'limit'],
  'runs.artifacts.read': ['sessionId', 'runId', 'id', 'cursor', 'limit'],
  'runs.artifacts.download': ['sessionId', 'runId', 'id', 'cursor', 'limit']
}
const sessionPattern = /^[A-Za-z0-9_-]{1,128}$/
const runPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/
const artifactPattern = /^art_[0-9a-f-]{36}$/
const hash = value => createHash('sha256').update(String(value)).digest('hex')
const fail = (code, message, status = 400) => { throw new ProtocolError(code, message, status) }
const integer = (value, fallback, min, max, label) => {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < min || result > max) fail('run_invalid', `${label}超出允许范围。`)
  return result
}
const readableArtifact = metadata => ['tool', 'document'].includes(metadata.source?.kind)
const publicArtifact = item => ({ id: item.id, sha256: item.sha256, size: item.size, mime: item.mime, createdAt: item.createdAt, source: { kind: item.source.kind } })

/** Remote projection intentionally excludes host grants, actor IDs, paths and
 * private acceptance artifacts. Shared access is to one canonical session. */
export class DeviceRuns {
  /** @param {any} service @param {{directory?: string, artifactOptions?: any}} [options] */
  constructor(service, options = {}) {
    this.service = service
    this.directory = options.directory || path.join(userRootDir(), 'run-store')
    this.artifacts = new ArtifactStore(options.artifactOptions)
    this.reader = null; this.writer = null; this.closed = false
  }

  actualOwner(principal) { return principal.id === 'local' || (principal.actorId || principal.id) === this.service.metadata.owner }
  async ledger(write = false) {
    if (this.closed) fail('device_closed', '设备已经关闭。', 409)
    try { await access(path.join(this.directory, 'runs.sqlite')) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    if (write) return this.writer ||= openRunStore({ directory: this.directory })
    return this.reader ||= openRunStore({ directory: this.directory, readOnly: true })
  }

  async session(params) {
    if (typeof params.sessionId !== 'string' || !sessionPattern.test(params.sessionId)) fail('invalid_session', '请选择有效的任务会话。')
    const saved = await getSession(params.sessionId)
    if (!saved?.session?.cwd) fail('session_missing', '任务会话不存在，请返回会话列表刷新。', 404)
    return { saved, cwd: saved.session.cwd, accountId: await currentArtifactAccountId() }
  }

  async boundRun(params, scope, store) {
    if (!store || typeof params.runId !== 'string' || !runPattern.test(params.runId)) fail('run_missing', '任务不存在或不属于当前会话。', 404)
    let run
    try { run = await store.getRun(params.runId) } catch (error) { if (error.code === 'RUN_NOT_FOUND') fail('run_missing', '任务不存在或不属于当前会话。', 404); throw error }
    if (!run.binding || run.binding.sessionId !== params.sessionId || run.binding.accountId !== scope.accountId || path.resolve(run.binding.cwd) !== path.resolve(scope.cwd)) fail('run_missing', '任务不存在或不属于当前会话。', 404)
    if (!RUN_STATES.includes(run.state)) fail('run_storage_error', '任务状态不完整，已停止显示可能误导的执行结果。', 409)
    return run
  }

  project(run, principal) {
    const latest = new Map()
    for (const receipt of run.verifications) if (receipt.candidateHash === run.candidateHash && receipt.candidateGeneration === run.candidateGeneration && receipt.contractVersion === run.contractVersion) latest.set(receipt.criterionId, receipt.status === 'passed' && !receipt.evidenceRefs?.length ? 'unknown' : receipt.status)
    const counts = { prepared: 0, succeeded: 0, failed: 0, unknown: 0, not_applied: 0 }
    for (const action of run.actions) if (Object.hasOwn(counts, action.state)) counts[action.state]++
    const statuses = run.contract.requiredCriteria.map(criterion => latest.get(criterion.id) || 'unknown')
    const owner = this.actualOwner(principal), terminal = ['completed', 'cancelled'].includes(run.state)
    return {
      id: run.id, sessionId: run.binding.sessionId, state: run.state, revision: run.revision, ownerEpoch: run.ownerEpoch,
      objective: String(run.contract.objective).slice(0, 4096), contractVersion: run.contractVersion,
      candidateHash: run.candidateHash, createdAt: run.createdAt, updatedAt: run.updatedAt,
      lastTurn: run.lastTurn ? { id: run.lastTurn.id, status: run.lastTurn.status, startedAt: run.lastTurn.startedAt, endedAt: run.lastTurn.endedAt || null } : null,
      actionCounts: counts,
      budget: run.budget ? { budgetUsd: run.budget.budgetUsd, spentUsd: run.budget.spentUsd, reservedUsd: run.budget.reservedUsd,
        unknownUsd: run.budget.unknownUsd, deadlineAt: run.budget.deadlineAt, hasUnknown: run.budget.requests.some(request => request.status === 'unknown') } : null,
      verification: { required: statuses.length, passed: statuses.filter(status => status === 'passed').length, failed: statuses.filter(status => status === 'failed').length, unknown: statuses.filter(status => !['passed', 'failed'].includes(status)).length },
      controls: { canPause: owner && !terminal && !['paused', 'outcome_unknown'].includes(run.state), canCancel: owner && !terminal }
    }
  }

  cursor(value, scope, sessionId) {
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('run_invalid_cursor', '任务列表游标无效，请刷新列表。')
    let parsed
    try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) } catch { fail('run_invalid_cursor', '任务列表游标无效，请刷新列表。') }
    if (!parsed || parsed.scope !== hash(`${scope.accountId}:${sessionId}`) || !runPattern.test(parsed.id || '') || !Number.isSafeInteger(parsed.updatedAt) || parsed.updatedAt < 0) fail('run_invalid_cursor', '任务列表游标不属于当前会话或账号。')
    return { id: parsed.id, updatedAt: parsed.updatedAt }
  }

  async handle(method, params, principal, scope) {
    const reader = await this.ledger()
    if (method === 'runs.list') {
      const limit = integer(params.limit, 30, 1, 100, '任务列表大小')
      const after = this.cursor(params.cursor, scope, params.sessionId)
      if (!reader) return { items: [], nextCursor: null, truncated: false }
      const summaries = await reader.listRuns({ sessionId: params.sessionId, accountId: scope.accountId, cwd: scope.cwd, limit: limit + 1, after })
      const visible = summaries.slice(0, limit), items = []
      for (const summary of visible) {
        try { items.push(this.project(await this.boundRun({ ...params, runId: summary.id }, scope, reader), principal)) }
        catch (error) { if (error.code !== 'run_missing') throw error }
      }
      const last = visible.at(-1)
      const nextCursor = summaries.length > limit && last ? Buffer.from(JSON.stringify({ scope: hash(`${scope.accountId}:${params.sessionId}`), id: last.id, updatedAt: last.updatedAt })).toString('base64url') : null
      return { items, nextCursor, truncated: Boolean(nextCursor) }
    }
    const run = await this.boundRun(params, scope, reader)
    if (method === 'runs.get') return this.project(run, principal)
    if (method === 'runs.events') {
      const events = await reader.events({ runId: run.id, after: integer(params.after, 0, 0, Number.MAX_SAFE_INTEGER, '事件游标'), limit: integer(params.limit, 100, 1, 200, '事件数量') })
      return { runId: run.id, revision: run.revision, events: events.map(event => ({ sequence: event.sequence, revision: event.revision, type: event.type, createdAt: event.createdAt,
        ...(typeof event.data?.actionId === 'string' ? { actionId: event.data.actionId } : {}),
        ...(typeof event.data?.state === 'string' ? { state: event.data.state } : {}),
        ...(typeof event.data?.to === 'string' ? { state: event.data.to } : {}),
        ...(event.type === 'control.requested' ? { control: event.data.kind } : {}) })), nextAfter: events.at(-1)?.sequence ?? params.after ?? 0 }
    }
    if (['runs.pause', 'runs.cancel'].includes(method)) {
      if (!this.actualOwner(principal)) fail('forbidden', '共享访客只能查看任务，不能暂停或取消设备所有者的委托。', 403)
      if (params.confirmed !== true) fail('confirmation_required', '请确认停止此任务；已有文件和结果会保留，未知副作用仍需核查。', 409)
      const revision = integer(params.expectedRevision, null, 1, Number.MAX_SAFE_INTEGER, '任务版本')
      const epoch = integer(params.expectedOwnerEpoch, null, 1, Number.MAX_SAFE_INTEGER, '执行代次')
      if (revision !== run.revision || epoch !== run.ownerEpoch) fail('run_changed', '任务状态已经变化，请刷新后重新确认。', 409)
      const writer = await this.ledger(true)
      const updated = await writer.requestControl({ runId: run.id, expectedRevision: revision, expectedOwnerId: run.ownerId, expectedOwnerEpoch: epoch,
        kind: method === 'runs.pause' ? 'pause' : 'cancel', requestId: `remote_${randomUUID()}`,
        approval: { approved: true, actorId: `remote_${hash(principal.actorId || principal.id).slice(0, 40)}`, reason: 'Authenticated device owner confirmed this exact run revision and epoch' } })
      this.service.emitDeviceEvent?.('runs.updated', { sessionId: params.sessionId, runId: run.id })
      return this.project(updated, principal)
    }
    const actor = { accountId: scope.accountId, projectId: run.binding.projectId, sessionId: run.binding.sessionId, runId: run.id }
    if (method === 'runs.artifacts.list') {
      const page = await this.artifacts.list({ actor, cursor: params.cursor, limit: integer(params.limit, 30, 1, 100, '产物列表大小') })
      return { items: page.items.filter(readableArtifact).map(publicArtifact), nextCursor: page.nextCursor }
    }
    if (typeof params.id !== 'string' || !artifactPattern.test(params.id)) fail('run_artifact_unavailable', '该任务没有可公开读取的此项产物。', 404)
    const metadata = await this.artifacts.getMetadata({ actor, id: params.id })
    if (!readableArtifact(metadata)) fail('run_artifact_unavailable', '该任务没有可公开读取的此项产物。', 404)
    const page = await this.artifacts.read({ actor, id: params.id, cursor: params.cursor, limit: integer(params.limit, method === 'runs.artifacts.download' ? 256 * 1024 : 16 * 1024, 1, 256 * 1024, '产物读取大小') })
    const extension = { 'application/json': 'json', 'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx' }[metadata.mime.split(';')[0]] || 'bin'
    return { ...page, mime: metadata.mime, ...(method === 'runs.artifacts.download' ? { filename: `${params.id}.${extension}` } : {}) }
  }

  async dispatch(method, params, principal) {
    try {
      this.service.assertOwner(principal)
      if (!Object.hasOwn(fields, method) || !params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !fields[method].includes(key))) fail('run_invalid', '任务请求参数无效，不能选择其他账号、项目、主机路径或授权来源。')
      const scope = await this.session(params)
      const result = await this.handle(method, params, principal, scope)
      this.service.assertOwner(principal)
      const current = await this.session(params)
      if (current.accountId !== scope.accountId || current.cwd !== scope.cwd) fail('run_scope_changed', '读取期间设备账号或会话工作区已经变化，已停止返回原任务资料。', 409)
      return result
    }
    catch (error) {
      if (error instanceof ProtocolError) throw error
      if (error.code === 'artifact_not_found') fail('run_artifact_unavailable', '该任务没有可公开读取的此项产物。', 404)
      if (['REVISION_CONFLICT', 'STALE_OWNER'].includes(error.code)) fail('run_changed', '任务状态已经变化，请刷新后重新确认。', 409)
      if (error.code === 'TERMINAL_RUN') fail('run_finished', '任务已经结束；停止不会撤销已有文件或远端副作用。', 409)
      if (error.code?.startsWith('artifact_')) throw new ProtocolError(error.code, error.message, error.status || 409)
      if (['STORE_CLOSED', 'STORE_UNAVAILABLE'].includes(error.code)) {
        const stale = [this.reader, this.writer].filter(Boolean)
        this.reader = null; this.writer = null
        await Promise.allSettled(stale.map(async pending => (await pending).close()))
      }
      fail('run_storage_error', '任务账本或证据无法可靠读取，已停止操作；请在本机检查数据库、版本和磁盘，不要重复执行未知操作。', 409)
    }
  }

  async close() {
    this.closed = true
    await Promise.allSettled([this.reader, this.writer].filter(Boolean).map(async pending => (await pending).close()))
    this.reader = null; this.writer = null
  }
}
