import { randomUUID } from 'node:crypto'
import { getSession, listSessions, updateSessionIf } from '../session/store.mjs'
import { BackgroundManager } from './background-manager.mjs'

const live = new Map()
const ACTIVE = new Set(['running', 'pending'])
const MAX_MESSAGES = 32
const MAX_MESSAGE_CHARS = 16000
const MAX_LIST_CHILDREN = 1000

async function parentChildren(parentSessionId) {
  if (typeof parentSessionId !== 'string' || !parentSessionId.trim()) throw new Error('A parent session is required to list delegated work')
  const sessions = await listSessions({ parentSessionId, limit: MAX_LIST_CHILDREN + 1 })
  if (sessions.length > MAX_LIST_CHILDREN) {
    throw Object.assign(new Error('This session has too many delegated records for a complete status snapshot; inspect them before declaring completion'), { code: 'child_list_overflow' })
  }
  return sessions.filter(session => session.childContract?.schema === 1 && session.childContract.parentSessionId === parentSessionId)
}

export async function ownedChild(parentSessionId, sessionId) {
  const entry = await getSession(sessionId)
  const session = entry?.session
  if (!parentSessionId || session?.childContract?.schema !== 1 || !session.childContractVersion || session.childContract.runSpec?.sessionId !== sessionId || session.childContract.runSpec?.parentSessionId !== parentSessionId || session.childContract.parentSessionId !== parentSessionId || session.parentSessionId !== parentSessionId) {
    throw new Error('delegated session not found or not owned by this parent')
  }
  return session
}

export async function acquireChildOperation(parentSessionId, sessionId, expectedVersion = null) {
  const session = await ownedChild(parentSessionId, sessionId)
  if (expectedVersion && expectedVersion !== session.childContractVersion) throw new Error('delegated session policy changed; reload before continuing')
  if (session.childOperationId) throw new Error('delegated session already has a live or unresolved operation; inspect it before continuing')
  const operationId = randomUUID()
  const acquired = await updateSessionIf(sessionId, { childOperationId: session.childOperationId, childContractVersion: session.childContractVersion, childMailboxRevision: session.childMailboxRevision, parentSessionId }, {
    childOperationId: operationId, childStatus: 'running', childBackgroundTaskId: null, childResult: null,
    childUndeliveredMessages: session.childMailbox || [], childMailbox: [], childMailboxRevision: randomUUID()
  })
  if (!acquired) throw new Error('delegated session changed or is already running')
  return operationId
}

export async function settleChildOperation(sessionId, operationId, result) {
  return updateSessionIf(sessionId, { childOperationId: operationId }, {
    childOperationId: null, childStatus: result.status, childResult: result, childSettledAt: Date.now()
  })
}

export function bindChildOperation(operationId, parentSignal) {
  const controller = new AbortController()
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal
  live.set(operationId, controller)
  return { signal, close: () => live.delete(operationId) }
}

export async function drainChildMessages(sessionId, operationId) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const session = (await getSession(sessionId))?.session
    if (!session || session.childOperationId !== operationId) throw new Error('child operation ownership was lost')
    if (!session.childMailbox?.length) return []
    const messages = session.childMailbox.filter(message => message.operationId === operationId)
    if (!messages.length) return []
    const saved = await updateSessionIf(sessionId, { childOperationId: operationId, childMailboxRevision: session.childMailboxRevision }, { childMailbox: session.childMailbox.filter(message => message.operationId !== operationId), childMailboxRevision: randomUUID() })
    if (saved) return messages.map(message => message.text)
  }
  throw new Error('child mailbox changed repeatedly; retry at next boundary')
}

export function childSteeringSource(sessionId, operationId) {
  const take = () => drainChildMessages(sessionId, operationId)
  take.hasPending = async () => {
    const session = (await getSession(sessionId))?.session
    return session?.childOperationId === operationId && session.childMailbox?.some(message => message.operationId === operationId) === true
  }
  return take
}

function summary(session) {
  return { session_id: session.id, parent_session_id: session.childContract.parentSessionId,
    subagent: session.childContract.runSpec.role.name, status: session.childStatus || 'unknown',
    background_task_id: session.childBackgroundTaskId || null, pending_messages: session.childMailbox?.length || 0,
    result: session.childResult || null }
}

/** Parent-scoped lifecycle API; no retries/replays of unfinished tool actions. */
/** @param {{parentSessionId?: string, delegateTask?: Function, config?: any, signal?: AbortSignal, hasPendingInput?: Function}} options */
export function createChildController({ parentSessionId, delegateTask, config = {}, signal, hasPendingInput } = {}) {
  const inspect = async sessionId => {
    let session = await ownedChild(parentSessionId, sessionId)
    if (session.childOperationId && session.childBackgroundTaskId) {
      const task = await BackgroundManager.get(session.childBackgroundTaskId)
      if (task && task.payload?.childOperationId === session.childOperationId && task.payload?.subSessionId === sessionId && task.payload?.parentSessionId === parentSessionId) {
        if (!ACTIVE.has(task.status)) {
          await settleChildOperation(sessionId, session.childOperationId, { ...(task.result || {}), status: task.result?.status && task.result.status !== 'completed' ? task.result.status : task.status, ...(task.error ? { error: task.error } : {}) })
          session = await ownedChild(parentSessionId, sessionId)
        } else session = { ...session, childStatus: task.status }
      }
    }
    return session
  }
  return {
    create: args => delegateTask(args),
    async list() {
      const sessions = await parentChildren(parentSessionId)
      return Promise.all(sessions.map(async session => summary(await inspect(session.id))))
    },
    async get(sessionId) { return summary(await inspect(sessionId)) },
    async wait(sessionId, { timeoutMs = 30000 } = {}) {
      const timeout = Math.min(60000, Math.max(0, Number(timeoutMs) || 0))
      const deadline = Date.now() + timeout
      let session
      do {
        signal?.throwIfAborted()
        session = await inspect(sessionId)
        if (!session.childOperationId || Date.now() >= deadline || await hasPendingInput?.()) break
        await BackgroundManager.waitForSettled(Math.min(100, deadline - Date.now()))
      } while (true)
      return { ...summary(session), timed_out: Boolean(session.childOperationId) }
    },
    async send(sessionId, text) {
      if (typeof text !== 'string' || !text.trim() || text.length > MAX_MESSAGE_CHARS) throw new Error(`child message must contain 1-${MAX_MESSAGE_CHARS} characters`)
      for (let attempt = 0; attempt < 8; attempt++) {
        const session = await inspect(sessionId)
        if (!session.childOperationId) throw new Error('child is idle; use followup to start a new turn')
        const mailbox = session.childMailbox || []
        if (mailbox.length >= MAX_MESSAGES) throw new Error('child mailbox is full; wait for delivery')
        const message = { id: randomUUID(), text, createdAt: Date.now(), operationId: session.childOperationId }
        if (await updateSessionIf(sessionId, { childOperationId: session.childOperationId, childMailboxRevision: session.childMailboxRevision }, { childMailbox: [...mailbox, message], childMailboxRevision: randomUUID() })) return { session_id: sessionId, message_id: message.id, status: 'queued' }
      }
      throw new Error('child mailbox is busy; retry')
    },
    async followup(sessionId, prompt, options = {}) {
      await inspect(sessionId)
      return delegateTask({ ...options, session_id: sessionId, prompt })
    },
    async interrupt(sessionId) {
      const session = await inspect(sessionId)
      if (!session.childOperationId) return summary(session)
      const controller = live.get(session.childOperationId)
      if (controller) controller.abort(new DOMException('Child interrupted by parent', 'AbortError'))
      else if (session.childBackgroundTaskId) await BackgroundManager.cancel(session.childBackgroundTaskId)
      else throw new Error('child operation owner is unavailable; state remains unresolved, not completed')
      return { ...summary(session), interrupt_requested: true }
    }
  }
}

/** Content-free reconnect projection; never expose prompts, policy or results. */
export async function listChildSnapshots(parentSessionId) {
  if (!parentSessionId) return []
  const sessions = await parentChildren(parentSessionId)
  return Promise.all(sessions
    .map(async session => {
      let status = session.childStatus || 'unknown'
      if (session.childOperationId && session.childBackgroundTaskId) {
        const task = await BackgroundManager.get(session.childBackgroundTaskId)
        if (task?.payload?.childOperationId === session.childOperationId && task.payload?.subSessionId === session.id && task.payload?.parentSessionId === parentSessionId) {
          status = task.result?.status && task.result.status !== 'completed' ? task.result.status : task.status
        }
      }
      return { session_id: session.id, parent_session_id: parentSessionId, subagent: session.childContract.runSpec?.role?.name || 'unknown',
        status, background_task_id: session.childBackgroundTaskId || null, pending_messages: session.childMailbox?.length || 0 }
    }))
}
