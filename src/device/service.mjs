import { randomUUID, createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, readFile } from 'node:fs/promises'
import { createKernel, getSession, listSessions, newSessionId, resolveModelCapabilities, resolveProviderConnection, assertMediaInput } from '../kernel/index.mjs'
import { loadConfig } from '../config/load-config.mjs'
import { redactConfig } from '../config/redact.mjs'
import { userRootDir } from '../storage/paths.mjs'
import { writePrivateFile } from '../storage/private-file.mjs'
import { acquireProcessLock } from '../storage/process-lock.mjs'
import { PROTOCOL_VERSION, ProtocolError, validateRequest } from '../protocol/index.mjs'
import { listDeviceFolder, readDeviceFile, resolveDevicePath } from './files.mjs'
import { listDeviceCommands, runDeviceCommand } from './commands.mjs'
import { discoverDeviceModels, updateDeviceSettings } from './model-settings.mjs'
import { ReplayStore } from './replay-store.mjs'
import { RequestLedger, REQUEST_WINDOW_MS } from './request-ledger.mjs'
import { AttachmentStore } from './attachments.mjs'
import { listDeviceBranches, changeDeviceBranch } from './branches.mjs'
import { SessionTree } from './session-tree.mjs'
import { getDeviceProfile, updateDeviceProfile } from './profile.mjs'
import { sessionView } from './session-view.mjs'
import { DeviceLiveView } from './live-view.mjs'
import { publicMcpSummary } from './mcp-status.mjs'

const idPattern = /^[A-Za-z0-9_-]{1,128}$/
export class DeviceService extends EventEmitter {
  constructor({ cwd = process.cwd(), roots = [os.homedir()], createKernelImpl = createKernel, retention = {} } = {}) {
    super()
    this.cwd = cwd; this.roots = roots; this.createKernel = createKernelImpl
    this.kernels = new Map(); this.turns = new Map(); this.leases = new Map(); this.approvals = new Map()
    this.inflight = new Map()
    this.commandStates = new Map()
    this.modelCatalog = new Map()
    this.sessionTransitions = new Set(); this.commandSessions = new Set(); this.commandContext = new AsyncLocalStorage()
    this.attachedKernels = new WeakSet(); this.detachKernels = []
    this.stateDir = path.join(userRootDir(), 'device')
    this.sessionTree = new SessionTree({ getSession }); this.retention = retention
    this.liveView = new DeviceLiveView()
    this.closed = false
  }
  async initialize() {
    if (this.initialized) return this
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 })
    this.stateLock = await acquireProcessLock(path.join(this.stateDir, 'device.lock'))
    try {
    try { this.metadata = JSON.parse(await readFile(path.join(this.stateDir, 'identity.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!this.metadata) { this.metadata = { id: randomUUID(), name: os.hostname(), owner: null }; await this.saveIdentity() }
    if (!idPattern.test(this.metadata.id)) throw new Error('Invalid device identity; inspect local state before recovery')
    this.replay = await new ReplayStore(this.stateDir, this.retention.replay).initialize()
    this.ledger = await new RequestLedger(path.join(this.stateDir, 'requests.json'), this.retention.requests).initialize()
    this.attachments = await new AttachmentStore({ directory: path.join(this.stateDir, 'attachments') }).initialize()
    this.initialized = true
    return this
    } catch (error) { await this.stateLock.release(); throw error }
  }
  async saveIdentity() { await writePrivateFile(path.join(this.stateDir, 'identity.json'), JSON.stringify(this.metadata)) }
  assertOwner(principal) {
    if (!principal || (principal.id !== 'local' && principal.id !== this.metadata.owner)) throw new ProtocolError('forbidden', 'Device owner access required', 403)
  }
  async bindOwner(id, profile) {
    if (this.metadata.owner && this.metadata.owner !== id) throw new ProtocolError('owner_conflict', 'This device belongs to a different account; unbind it locally first', 409)
    this.metadata.owner = id; this.metadata.profile = profile; await this.saveIdentity()
  }
  async kernel(cwd = this.cwd) {
    cwd = await resolveDevicePath(cwd, this.roots, { directory: true })
    if (!this.kernels.has(cwd)) {
      const promise = this.createKernel({ cwd, boot: false }).then(kernel => { this.attachKernel(kernel); return kernel })
      this.kernels.set(cwd, promise)
      promise.catch(() => this.kernels.delete(cwd))
    }
    return this.kernels.get(cwd)
  }
  attachKernel(kernel) {
    if (this.attachedKernels.has(kernel)) return
    this.attachedKernels.add(kernel)
    this.kernels.set(kernel.cwd, Promise.resolve(kernel))
    const unsubscribe = kernel.events.subscribe(event => this.record(event))
    kernel.prompts.permission.setPermissionPromptInterceptor((request, local) => this.ask('permission', request, local))
    kernel.prompts.question.setQuestionPromptInterceptor((request, local) => this.ask('question', request, local))
    const originalExecute = kernel.executeTurn, originalTurnsExecute = kernel.turns?.executeTurn
    const execute = originalExecute.bind(kernel)
    kernel.executeTurn = options => {
      if (this.workspaceMutation || this.configurationUpdating || this.closed) return Promise.reject(new ProtocolError('device_busy', 'Wait for device maintenance to finish', 409))
      if (this.sessionTransitions.has(options.sessionId) || this.commandSessions.has(options.sessionId) && this.commandContext.getStore()?.sessionId !== options.sessionId) return Promise.reject(new ProtocolError('session_busy', 'A session command or configuration transition is in progress', 409))
      const sessionId = options.sessionId || newSessionId(), existing = this.turns.get(sessionId)
      if (existing && existing.controller.signal === options.signal) return execute(options)
      if (existing) return Promise.reject(new ProtocolError('turn_busy', 'Another client is already running this session', 409))
      const controller = new AbortController(), entry = { controller, origin: 'terminal', client: 'local', turnId: randomUUID() }
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
      entry.signal = signal
      this.turns.set(sessionId, entry); this.leases.set(sessionId, { client: 'local', until: Date.now() + 60000 })
      entry.promise = Promise.resolve().then(() => execute({ ...options, sessionId, signal }))
        .then(async result => { await this.record({ type: 'turn.result', sessionId, turnId: result.turnId || entry.turnId, payload: result }); return result })
        .catch(async error => { await this.record({ type: 'turn.failed', sessionId, turnId: entry.turnId, payload: { error: error.message } }); throw error })
        .finally(() => this.finishTurn(sessionId, entry))
      return entry.promise
    }
    // Both public kernel entry points must participate in the same turn broker.
    if (kernel.turns) kernel.turns.executeTurn = kernel.executeTurn
    this.detachKernels.push(() => { unsubscribe(); kernel.executeTurn = originalExecute; if (kernel.turns) kernel.turns.executeTurn = originalTurnsExecute; kernel.prompts.permission.setPermissionPromptInterceptor(null); kernel.prompts.question.setQuestionPromptInterceptor(null) })
  }
  finishTurn(sessionId, entry) {
    if (this.turns.get(sessionId) === entry) this.turns.delete(sessionId)
    if (this.leases.get(sessionId)?.client === entry.client) this.leases.delete(sessionId)
    for (const approval of [...this.approvals.values()]) if (approval.sessionId === sessionId) this.resolveApproval(approval.id, approval.kind === 'permission' ? 'deny' : {})
  }
  async record(event) {
    if (this.closed) return
    if (event.type === 'mcp.loaded') return this.emitDeviceEvent('mcp.loaded', publicMcpSummary(event.payload))
    if (!event.sessionId || !idPattern.test(event.sessionId)) return
    this.sessionTree.observe(event)
    const row = await this.liveView.record(event, item => this.replay.append(item))
    this.emit('event', row)
    return row
  }
  async readEvents(sessionId, after) {
    if (!idPattern.test(sessionId)) throw new ProtocolError('invalid_session', 'Invalid session id')
    return (await this.replay.read(sessionId, after, 1000)).events
  }
  /** Live control/running snapshot for one session. Pure read: no lease renewal. */
  sessionState(sessionId, principal = { id: 'local', client: 'local' }) {
    const lease = this.leases.get(sessionId)
    let pendingApprovalCount = 0
    for (const approval of this.approvals.values()) if (approval.sessionId === sessionId) pendingApprovalCount++
    return { running: this.turns.has(sessionId), control: lease && lease.until > Date.now() ? { yours: lease.client === principal.client, until: lease.until } : null, pendingApprovalCount }
  }
  /** The events.list envelope. Watching a session (polling or SSE) renews the
   * caller's lease; acquiring control still requires control.acquire. */
  async sessionEvents(sessionId, after = 0, principal = { id: 'local', client: 'local' }) {
    if (!idPattern.test(sessionId)) throw new ProtocolError('invalid_session', 'Invalid session id')
    const lease = this.leases.get(sessionId)
    if (lease?.client === principal.client) lease.until = Date.now() + 60000
    const pending = [...this.approvals.values()].filter(a => a.sessionId === sessionId), approvals = []
    let remaining = 512 * 1024
    for (const { id, kind, request } of pending) {
      const item = { id, kind, request: redactConfig(request) }, bytes = Buffer.byteLength(JSON.stringify(item))
      if (bytes > remaining) break
      approvals.push(item); remaining -= bytes
    }
    return { ...await this.replay.read(sessionId, after), ...this.sessionState(sessionId, principal), approvals, pendingApprovalCount: pending.length }
  }
  /** Device-scope live event (no session, not journaled): settings/model changes.
   * Flat shape everywhere — in-process 'device' channel and SSE/relay wire:
   * {type, deviceId, timestamp, ...payload}. Envelope keys win collisions. */
  emitDeviceEvent(type, payload = {}) {
    const event = { ...payload, type, deviceId: this.metadata?.id || null, timestamp: Date.now() }
    this.emit('device', event)
    return event
  }
  /** Announce a discovered catalog once per actual change; SSE transports forward it. */
  announceModelCatalog(result) {
    if (!result || typeof result.provider !== 'string' || !Array.isArray(result.models)) return
    const digest = createHash('sha256').update(JSON.stringify(result.models)).digest('hex')
    if (this.modelCatalog.get(result.provider) === digest) return
    this.modelCatalog.set(result.provider, digest)
    const models = []
    let bytes = 2, truncated = false
    for (const model of result.models) {
      bytes += Buffer.byteLength(JSON.stringify(model)) + 1
      if (models.length >= 200 || bytes > 256 * 1024) { truncated = true; break }
      models.push(model)
    }
    this.emitDeviceEvent('models.updated', { provider: result.provider, source: result.source, stale: result.stale === true, models, ...(truncated ? { truncated: true } : {}) })
  }
  async ask(kind, request, localPrompt = null) {
    if (!request.sessionId || this.closed) return kind === 'permission' ? 'deny' : {}
    if (request.parentSessionId) this.sessionTree.remember(request.sessionId, request.parentSessionId, request.subagent)
    const route = await this.sessionTree.route(request.sessionId)
    if (this.closed) return kind === 'permission' ? 'deny' : {}
    const id = randomUUID(), sessionId = route.sessionId, controller = new AbortController()
    request = { ...request, ...route, sourceSessionId: route.originSessionId, sourceLabel: route.subagent || route.originSessionId }
    if (Buffer.byteLength(JSON.stringify(redactConfig(request))) > 128 * 1024) throw new ProtocolError('approval_too_large', 'Approval arguments exceed 128 KiB; split this operation into smaller reviewable steps', 413)
    return new Promise(resolve => {
      const timer = setTimeout(() => { if (this.approvals.has(id)) this.resolveApproval(id, kind === 'permission' ? 'deny' : {}) }, 300000)
      timer.unref?.()
      const signals = [...route.ancestry.map(id => this.turns.get(id)?.signal || this.turns.get(id)?.controller.signal).filter(Boolean), ...(request.signal ? [request.signal] : [])]
      const turnSignal = signals.length ? AbortSignal.any(signals) : null
      if (turnSignal?.aborted) { clearTimeout(timer); resolve(kind === 'permission' ? 'deny' : {}); return }
      const abortTurn = () => { if (this.approvals.has(id)) this.resolveApproval(id, kind === 'permission' ? 'deny' : {}) }
      this.approvals.set(id, { id, kind, sessionId, request, resolve, timer, controller, turnSignal, abortTurn })
      void this.record({ type: 'approval.requested', sessionId, payload: { id, kind, ...redactConfig(request) } })
      turnSignal?.addEventListener('abort', abortTurn, { once: true })
      if (turnSignal?.aborted) abortTurn()
      if (localPrompt) Promise.resolve().then(() => localPrompt({ ...request, signal: controller.signal })).then(answer => {
        if (this.approvals.has(id)) this.resolveApproval(id, answer)
      }).catch(() => { if (this.approvals.has(id)) this.resolveApproval(id, kind === 'permission' ? 'deny' : {}) })
    })
  }
  resolveApproval(id, answer) {
    const pending = this.approvals.get(id)
    if (!pending) throw new ProtocolError('approval_closed', 'Approval already answered or expired', 409)
    if (pending.kind === 'permission' && !['allow_once', 'allow_session', 'allow_always', 'deny'].includes(answer)) throw new ProtocolError('invalid_answer', 'Unknown permission decision')
    if (pending.kind === 'question' && (!answer || typeof answer !== 'object' || Array.isArray(answer))) throw new ProtocolError('invalid_answer', 'Question answers must be keyed by question id')
    clearTimeout(pending.timer); pending.turnSignal?.removeEventListener('abort', pending.abortTurn); this.approvals.delete(id); pending.resolve(answer); pending.controller.abort()
    void this.record({ type: 'approval.resolved', sessionId: pending.sessionId, payload: { id } })
    return { resolved: true }
  }
  lease(sessionId, principal) {
    const lease = this.leases.get(sessionId)
    if (!lease || lease.until < Date.now() || lease.client !== principal.client) throw new ProtocolError('control_required', 'Acquire session control first', 409)
    lease.until = Date.now() + 60000
  }
  async request(request, principal = { id: 'local', client: 'local' }) {
    validateRequest(request); this.assertOwner(principal)
    if (this.closed) throw new ProtocolError('device_offline', 'Device is closing', 503)
    const { id, method, params = {} } = request
    const mutating = !/^(status|folders\.list|files\.read|sessions\.(list|get)|events\.list|commands\.list|settings\.get|extensions\.list|models\.discover|attachments\.list|branches\.list|profile\.get)$/.test(method)
    const key = `${principal.id}:${id}`, hash = createHash('sha256').update(JSON.stringify({ method, params })).digest('hex')
    if (mutating && this.ledger.get(key)) {
      const prior = this.ledger.get(key)
      if (prior.hash !== hash) throw new ProtocolError('request_conflict', 'Request id reused with different parameters', 409)
      if (this.inflight.has(key)) return this.inflight.get(key)
      if (prior.state === 'failed') throw new ProtocolError(prior.error.code, prior.error.message, prior.error.status)
      if (prior.state !== 'done') throw new ProtocolError('outcome_unknown', 'Previous operation may have run; inspect session state before retrying', 409)
      if (prior.omitted) throw new ProtocolError('result_expired', 'The operation completed; reload its state instead of replaying a large result', 409)
      return prior.result
    }
    if (mutating && request.issuedAt != null && request.issuedAt < Date.now() - REQUEST_WINDOW_MS) throw new ProtocolError('request_expired', 'This request is outside the retry window; inspect its outcome before starting a new request', 409)
    const operation = (async () => {
      if (mutating) await this.ledger.reserve(key, hash)
      try {
        const result = await this.dispatch(method, params, principal)
        if (mutating) await this.ledger.complete(key, result)
        return result
      } catch (error) { if (mutating) await this.ledger.fail(key, error); throw error }
    })()
    this.inflight.set(key, operation)
    try { return await operation } finally { this.inflight.delete(key) }
  }
  async dispatch(method, p, principal) {
    const sessionId = p.sessionId
    if ((this.workspaceMutation || this.configurationUpdating) && ['sessions.create', 'sessions.configure', 'settings.update', 'extensions.reload', 'models.discover'].includes(method)) throw new ProtocolError('workspace_busy', 'Wait for device maintenance to finish', 409)
    if (method === 'status') return { schemaVersion: PROTOCOL_VERSION, device: this.metadata, roots: this.roots, active: [...this.turns.keys()], retention: { replay: this.replay.stats(), requests: this.ledger.stats() } }
    if (method === 'folders.list') return listDeviceFolder(p.path, this.roots)
    if (method === 'files.read') return readDeviceFile(p.path, this.roots)
    if (method === 'sessions.list') return (await listSessions({ limit: 200, includeChildren: false })).map(session => {
      const metadata = sessionView({ session, messages: [], parts: [] })
      for (const key of ['messages', 'parts', 'historyHasMore', 'nextBefore', 'partsTruncated']) delete metadata[key]
      return { ...metadata, ...(this.turns.has(session.id) ? { status: 'running' } : {}) }
    })
    if (method === 'sessions.get') {
      return this.liveView.snapshot(sessionId, {
        readCursor: () => this.replay.read(sessionId, 0, 1),
        readCanonical: () => getSession(sessionId),
        project: data => ({ ...sessionView(data, { before: p.before, limit: p.limit }), running: this.turns.has(sessionId) }),
        includeLive: !p.before
      })
    }
    if (method === 'sessions.create') {
      const kernel = await this.kernel(p.cwd)
      const id = newSessionId()
      await kernel.sessions.touchSession({ sessionId: id, cwd: kernel.cwd, mode: 'assistant', providerType: kernel.configState.config.provider.default, model: '', title: p.title || '新对话' })
      return { id, cwd: kernel.cwd }
    }
    if (method === 'events.list') return this.sessionEvents(sessionId, Number(p.after) || 0, principal)
    if (method === 'sessions.configure') {
      this.lease(sessionId, principal)
      if (this.sessionTransitions.has(sessionId) || this.commandSessions.has(sessionId) && this.commandContext.getStore()?.sessionId !== sessionId) throw new ProtocolError('session_busy', 'A session configuration or command is already in progress', 409)
      if (this.turns.has(sessionId)) throw new ProtocolError('turn_busy', 'Wait for this turn to finish before switching its model or mode', 409)
      this.sessionTransitions.add(sessionId)
      try {
      const session = await getSession(sessionId)
      if (!session) throw new ProtocolError('session_missing', 'Session not found', 404)
      const kernel = await this.kernel(session.session.cwd), config = kernel.configState.config
      this.lease(sessionId, principal)
      const providerType = p.provider || session.session.providerType || config.provider.default
      if (!Object.hasOwn(config.provider, providerType) || !config.provider[providerType] || typeof config.provider[providerType] !== 'object') throw new ProtocolError('unknown_provider', 'Configure this provider before selecting it')
      if (p.model != null && (typeof p.model !== 'string' || !p.model.trim() || p.model.length > 200 || /[\x00-\x1f]/.test(p.model))) throw new ProtocolError('invalid_model', 'Invalid model id')
      if (p.mode != null && !['agent', 'plan', 'agent-auto', 'ultra', 'yolo'].includes(p.mode)) throw new ProtocolError('invalid_mode', 'Unknown execution mode')
      if (p.approval != null && !['readonly', 'manual', 'accept-edits', 'yolo'].includes(p.approval)) throw new ProtocolError('invalid_approval', 'Unknown permission level')
      const modeId = p.mode || session.session.modeId || 'agent'
      const state = { providerType, model: p.model || (p.provider ? config.provider[providerType].default_model : session.session.model) || config.provider[providerType].default_model || '', modeId, mode: { agent: 'assistant', plan: 'plan', 'agent-auto': 'assistant', ultra: 'longagent', yolo: 'assistant' }[modeId], approval: { agent: 'manual', plan: 'readonly', 'agent-auto': 'accept-edits', ultra: 'accept-edits', yolo: 'yolo' }[modeId], sessionId }
      state.approval = p.approval || (!p.mode && session.session.approval) || state.approval
      this.commandStates.set(sessionId, state)
      await kernel.sessions.updateSession(sessionId, state)
      await this.record({ type: 'session.configured', sessionId, payload: state })
      return state
      } finally { this.sessionTransitions.delete(sessionId) }
    }
    if (method === 'control.acquire') {
      const prior = this.leases.get(sessionId)
      if ((this.sessionTransitions.has(sessionId) || this.commandSessions.has(sessionId) || this.workspaceMutation) && prior?.client !== principal.client) throw new ProtocolError('control_busy', 'Wait for the accepted session operation to finish before taking over', 409)
      const owner = principal.id === 'local' || (principal.actorId || principal.id) === this.metadata.owner
      if (prior?.until > Date.now() && prior.client !== principal.client && principal.client !== 'local' && !(p.takeover === true && owner)) throw new ProtocolError('control_busy', 'Another client controls this session; the owner may explicitly take over', 409)
      const lease = { client: principal.client, until: Date.now() + 60000 }; this.leases.set(sessionId, lease); return lease
    }
    if (method === 'control.release') {
      this.lease(sessionId, principal)
      if (this.sessionTransitions.has(sessionId) || this.commandSessions.has(sessionId) || this.workspaceMutation?.sessionId === sessionId) throw new ProtocolError('control_busy', 'The accepted session operation has not finished', 409)
      this.leases.delete(sessionId); return { released: true }
    }
    if (method === 'approvals.resolve') {
      const a = this.approvals.get(p.id)
      if (!a || a.sessionId !== p.sessionId) throw new ProtocolError('approval_session_mismatch', 'Approval does not belong to this session', 403)
      return this.resolveApproval(p.id, p.answer)
    }
    if (method === 'turns.cancel') { this.lease(sessionId, principal); this.turns.get(sessionId)?.controller.abort(); return { cancelled: true } }
    if (method === 'turns.start') {
      if (this.configurationUpdating || this.workspaceMutation) throw new ProtocolError('configuration_busy', 'Device configuration or Git branch is changing; retry after it completes', 409)
      this.lease(sessionId, principal)
      if (this.sessionTransitions.has(sessionId) || this.commandSessions.has(sessionId) && this.commandContext.getStore()?.sessionId !== sessionId) throw new ProtocolError('session_busy', 'A session command or configuration transition is in progress', 409)
      if (this.turns.has(sessionId)) throw new ProtocolError('turn_busy', 'A turn is already running', 409)
      if (typeof p.prompt !== 'string' || !p.prompt.trim() || p.prompt.length > 200000) throw new ProtocolError('invalid_prompt', 'Prompt must contain 1–200000 characters')
      const controller = new AbortController(), turnId = randomUUID()
      const entry = { controller, turnId, origin: 'remote', client: principal.client }; this.turns.set(sessionId, entry)
      let attachmentInput
      try {
      const session = await getSession(sessionId)
      if (!session) throw new ProtocolError('session_missing', 'Session not found', 404)
      const kernel = await this.kernel(session.session.cwd || this.cwd)
      if (!session.messages.length && ['New session', '新对话', ''].includes(session.session.title || '')) await kernel.sessions.updateSession(sessionId, { title: p.prompt.trim().replace(/\s+/g, ' ').slice(0, 60) })
      const config = kernel.configState.config, selection = this.commandStates.get(sessionId) || session.session
      const providerType = p.provider || selection.providerType || config.provider.default
      if (!Object.hasOwn(config.provider, providerType) || !config.provider[providerType] || typeof config.provider[providerType] !== 'object') { this.turns.delete(sessionId); throw new ProtocolError('unknown_provider', 'Unknown provider') }
      const mode = p.mode || selection.modeId || 'agent'
      const allowedModes = { agent: 'assistant', plan: 'plan', 'agent-auto': 'assistant', ultra: 'longagent', yolo: 'assistant' }
      if (!Object.hasOwn(allowedModes, mode)) { this.turns.delete(sessionId); throw new ProtocolError('invalid_mode', 'Unknown mode') }
      const state = structuredClone(kernel.configState)
      state.config.permission.level = ((!p.mode || p.mode === selection.modeId) && selection.approval) || { agent: 'manual', plan: 'readonly', 'agent-auto': 'accept-edits', ultra: 'accept-edits', yolo: 'yolo' }[mode]
      attachmentInput = await this.attachments.resolve({ sessionId, ids: p.attachmentIds || [], prompt: p.prompt })
      const model = p.model || selection.model || config.provider[providerType]?.default_model
      const media = (attachmentInput.contentBlocks || []).filter(block => ['image', 'audio', 'video'].includes(block.type))
      if (media.length) {
        const { capabilities } = await resolveModelCapabilities(state, providerType, model)
        const { protocol } = resolveProviderConnection(state, providerType)
        try { for (const block of media) assertMediaInput(block, { capabilities, protocol, provider: providerType, model }) }
        catch (error) { throw new ProtocolError('unsupported_attachment', error.message) }
      }
      let skillAllowedTools = null
      if (p.skill !== undefined) {
        if (typeof p.skill !== 'string' || p.skill.length > 256) throw new ProtocolError('invalid_skill', 'Invalid skill name')
        await kernel.bootExtensions()
        const skill = kernel.extensions.skills.get(p.skill)
        if (!skill || skill.userInvocable === false) throw new ProtocolError('invalid_skill', 'Skill is not user-invocable')
        skillAllowedTools = skill.allowedTools || null
      }
      await kernel.events.emit({ type: 'remote.turn.started', sessionId, payload: { prompt: p.prompt, client: principal.client } })
      entry.promise = kernel.executeTurn({ prompt: p.prompt, contentBlocks: attachmentInput.contentBlocks, sessionId, mode: allowedModes[mode], model, providerType, configState: state, signal: controller.signal, toolContext: { skillAllowedTools } })
        .then(result => this.record({ type: 'turn.result', sessionId, turnId: result.turnId || turnId, payload: result }))
        .catch(error => this.record({ type: 'turn.failed', sessionId, turnId, payload: { error: error.message } }))
        .finally(async () => { try { await attachmentInput.release() } finally { this.finishTurn(sessionId, entry) } })
      return { accepted: true, turnId }
      } catch (error) { try { await attachmentInput?.release() } finally { this.finishTurn(sessionId, entry) }; throw error }
    }
    if (method.startsWith('attachments.')) {
      if (!await getSession(sessionId)) throw new ProtocolError('session_missing', 'Session not found', 404)
      if (method === 'attachments.list') return this.attachments.list(p)
      return method === 'attachments.upload' ? this.attachments.upload(p) : this.attachments.remove(p)
    }
    if (method === 'profile.get') return getDeviceProfile()
    if (method === 'profile.update') return updateDeviceProfile(p.profile)
    if (method.startsWith('branches.')) {
      const session = sessionId && await getSession(sessionId)
      if (sessionId && !session) throw new ProtocolError('session_missing', 'Session not found', 404)
      const cwd = session?.session.cwd || p.cwd || this.cwd
      if (method === 'branches.list') return listDeviceBranches(cwd, this.roots)
      if (sessionId) this.lease(sessionId, principal)
      if (this.workspaceMutation || this.configurationUpdating) throw new ProtocolError('workspace_busy', 'Device maintenance is already in progress', 409)
      this.workspaceMutation = { sessionId, client: principal.client }
      try {
        const assertIdle = async () => {
          if (this.turns.size || this.commandSessions.size || this.sessionTransitions.size) throw new ProtocolError('turn_busy', 'Finish all running turns and commands before switching Git branches', 409)
          for (const promise of this.kernels.values()) { const k = await promise; if ((await k.background?.list?.() || []).some(job => ['queued', 'running', 'pending'].includes(job.status))) throw new ProtocolError('turn_busy', 'A background task is still using this device', 409) }
        }
        await assertIdle()
        const result = await changeDeviceBranch({ ...p, cwd, roots: this.roots, create: method === 'branches.create', assertIdle })
        if (sessionId) await this.record({ type: 'session.branch.changed', sessionId, payload: { branch: result.current, cwd, head: result.head } })
        return result
      } finally { this.workspaceMutation = false }
    }
    if (method === 'settings.get') return redactConfig((await loadConfig(this.cwd)).config)
    if (method === 'settings.update') {
      if (this.configurationUpdating || this.commandSessions.size || this.sessionTransitions.size) throw new ProtocolError('configuration_busy', 'A configuration update or session operation is in progress', 409)
      this.configurationUpdating = true
      try {
        const result = await updateDeviceSettings(this, p.config)
        this.emitDeviceEvent('settings.updated', {})
        const provider = result.config?.provider?.default
        if (provider) void discoverDeviceModels(this, { provider }).then(catalog => this.announceModelCatalog(catalog)).catch(() => {})
        return result
      } finally { this.configurationUpdating = false }
    }
    if (method === 'models.discover') {
      const catalog = await discoverDeviceModels(this, p)
      this.announceModelCatalog(catalog)
      return catalog
    }
    if (method === 'commands.run') {
      this.lease(sessionId, principal)
      if (this.turns.has(sessionId) || this.workspaceMutation || this.configurationUpdating || this.commandSessions.has(sessionId) || this.sessionTransitions.has(sessionId)) throw new ProtocolError('turn_busy', 'Wait for the active turn, command or branch change to finish', 409)
      this.commandSessions.add(sessionId)
      try {
        const kernel = await this.kernel((sessionId && (await getSession(sessionId))?.session.cwd) || this.cwd)
        this.lease(sessionId, principal)
        return await this.commandContext.run({ sessionId }, () => runDeviceCommand({ service: this, kernel, sessionId, command: p.command, principal }))
      } finally { this.commandSessions.delete(sessionId) }
    }
    const kernel = await this.kernel(p.cwd || (sessionId && (await getSession(sessionId))?.session.cwd) || this.cwd)
    if (method === 'extensions.list' || method === 'extensions.reload') {
      await kernel.bootExtensions()
      if (method === 'extensions.reload') { await kernel.extensions.skills.initialize(kernel.extensionPolicy.config, kernel.cwd, { allowProjectSources: kernel.extensionPolicy.allowProjectSources }); await kernel.extensions.mcp.initialize(kernel.extensionPolicy.config, { cwd: kernel.cwd, force: true, allowProjectSources: kernel.extensionPolicy.allowProjectSources }) }
      return { skills: kernel.extensions.skills.list().map(({ run, ...s }) => s), mcp: kernel.extensions.mcp.healthSnapshot(), plugins: kernel.extensions.skills.listPluginManifests() }
    }
    if (method === 'commands.list') return listDeviceCommands({ kernel })
    throw new ProtocolError('unknown_method', 'Unsupported operation')
  }
  close() {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = (async () => {
    try {
    for (const entry of this.turns.values()) entry.controller.abort()
    for (const a of [...this.approvals.values()]) this.resolveApproval(a.id, a.kind === 'permission' ? 'deny' : {})
    await Promise.allSettled(this.inflight.values())
    await Promise.allSettled([...this.turns.values()].map(entry => entry.promise))
    for (const detach of this.detachKernels) detach()
    await Promise.allSettled([...this.kernels.values()].map(async p => (await p).shutdown()))
    await this.liveView.close(); await this.replay?.close(); await this.ledger?.close(); await this.attachments?.chain.catch(() => {})
    this.leases.clear()
    this.sessionTree.clear()
    this.modelCatalog.clear()
    } finally { await this.stateLock?.release() }
    })()
    return this.closePromise
  }
}
