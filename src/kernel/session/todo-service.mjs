import { getTodoSnapshot, updateTodos } from './store.mjs'
import { currentRuntime, runWithRuntime } from '../core/runtime-context.mjs'
import { EventBus } from '../core/events.mjs'

const services = new WeakSet()
const denied = () => { throw Object.assign(new Error('Todo service belongs to a different session'), { code: 'todo_scope', status: 403 }) }
export const isSessionTodoService = value => Boolean(value && services.has(value))

/** A host-created, session-bound capability. Its observed revision is captured
 * before model execution, never refreshed implicitly just before a stale write.
 * @param {{sessionId: string, agentId?: string, turnId?: string | null, emit?: (event: any) => any}} options */
export async function createSessionTodoService({ sessionId, agentId = 'main', turnId = null, emit = event => EventBus.emit(event) }) {
  const ownerRuntime = currentRuntime()
  const runOwned = fn => ownerRuntime ? runWithRuntime(ownerRuntime, fn) : fn()
  const assertScope = requested => {
    if (requested !== undefined && requested !== sessionId) denied()
    const runtimeSession = currentRuntime()?.sessionId
    if (runtimeSession && runtimeSession !== sessionId) denied()
  }
  assertScope()
  const initial = await getTodoSnapshot(sessionId)
  if (!initial) throw Object.assign(new Error('Todo session does not exist'), { code: 'session_missing', status: 404 })
  let observedRevision = initial.revision
  const service = Object.freeze({
    sessionId,
    agentId,
    /** Read-only callers may inspect current state without advancing the writer's
     * CAS baseline. Explicit refresh is reserved for re-planning after conflict. */
    async list({ refresh = false } = {}) {
      assertScope()
      return runOwned(async () => {
        const snapshot = await getTodoSnapshot(sessionId)
        if (!snapshot) throw Object.assign(new Error('Todo session does not exist'), { code: 'session_missing', status: 404 })
        if (refresh) observedRevision = snapshot.revision
        return snapshot
      })
    },
    /** @param {any} input @param {{sessionId?: string, signal?: AbortSignal}} [options] */
    async update(input, { sessionId: requested, signal } = {}) {
      assertScope(requested); signal?.throwIfAborted()
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('Invalid todo update'), { code: 'todo_invalid' })
      return runOwned(async () => {
        const expectedRevision = input.expectedRevision ?? observedRevision
        const snapshot = await updateTodos(sessionId, { ...input, expectedRevision }, { agentId, turnId, signal })
        observedRevision = snapshot.revision
        // Persistence precedes notification. A disconnected UI can recover using
        // todos.list/sessions.get even if a live event cannot be delivered.
        try { await emit({ type: 'todo.updated', sessionId, turnId, payload: { snapshot: structuredClone(snapshot) } }) } catch { /* Durable state remains recoverable if a transport listener fails. */ }
        return structuredClone(snapshot)
      })
    }
  })
  services.add(service)
  return service
}
