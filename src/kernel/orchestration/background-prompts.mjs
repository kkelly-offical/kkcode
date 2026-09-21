import { randomUUID } from 'node:crypto'
import { currentRuntime, runWithRuntime } from '../core/runtime-context.mjs'

// Ephemeral capabilities, keyed by the exact task that the kernel launched.
// They are never written into task checkpoints or inherited by another kernel.
const owners = new Map()
const safeAnswer = kind => kind === 'permission' ? 'deny' : {}
const send = (peer, value) => { if (peer.connected !== false) { try { peer.send(value, () => {}) } catch { /* disconnected: fail closed */ } } }

export function registerBackgroundPromptOwner(taskId, runtime = currentRuntime()) {
  if (!runtime || (!runtime.permissionPrompt?.canAskInteractively() && !runtime.questionPrompt?.hasPromptHandler()) || runtime.hostSignal?.aborted) return false
  releaseBackgroundPromptOwner(taskId)
  const controller = new AbortController()
  const abort = () => releaseBackgroundPromptOwner(taskId)
  const signals = [runtime.signal, runtime.hostSignal].filter(Boolean)
  if (signals.some(signal => signal.aborted)) return false
  for (const signal of signals) signal.addEventListener('abort', abort, { once: true })
  owners.set(taskId, { runtime, controller, cleanup: () => { for (const signal of signals) signal.removeEventListener('abort', abort) } })
  return true
}
export function hasBackgroundPromptOwner(taskId) { return owners.has(taskId) }
export function releaseBackgroundPromptOwner(taskId) {
  const owner = owners.get(taskId)
  if (!owner) return
  owners.delete(taskId); owner.controller.abort(); owner.cleanup()
}

/** The private OS IPC pipe authenticates the worker; all authority comes from task. */
export function bindBackgroundPromptWorker(child, task) {
  const owner = owners.get(task.id)
  if (!owner) return () => {}
  const pending = new Map()
  const receive = message => {
    if (!message || typeof message !== 'object' || typeof message.id !== 'string') return
    if (message.type === 'kkcode.prompt.cancel') { pending.get(message.id)?.abort(); return }
    if (message.type !== 'kkcode.prompt.request' || !['permission', 'question'].includes(message.kind)) return
    const kind = message.kind
    if (pending.has(message.id)) return
    if (pending.size >= 64 || message.id.length > 100 || JSON.stringify(message.request || {}).length > 512000 || owner.controller.signal.aborted) {
      send(child, { type: 'kkcode.prompt.response', id: message.id, answer: safeAnswer(kind) }); return
    }
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, owner.controller.signal])
    pending.set(message.id, controller)
    // Ignore every identity supplied by the worker, including nested delegates.
    // The request is always aggregated under this task's original child/root.
    const request = { ...(message.request || {}), sessionId: task.payload.subSessionId, parentSessionId: task.payload.parentSessionId, subagent: task.payload.subagent || task.payload.subagentType || null, signal }
    const runtime = { ...owner.runtime, sessionId: request.sessionId, parentSessionId: request.parentSessionId, subagent: request.subagent }
    const ask = () => kind === 'permission'
      ? owner.runtime.permissionPrompt.askPermissionInteractive(request)
      : task.payload.allowQuestion === true ? owner.runtime.questionPrompt.askQuestionInteractive(request) : safeAnswer(kind)
    let cancelled
    const cancellation = new Promise(resolve => {
      cancelled = () => resolve(safeAnswer(kind))
      if (signal.aborted) cancelled()
      else signal.addEventListener('abort', cancelled, { once: true })
    })
    Promise.race([Promise.resolve().then(() => signal.aborted ? safeAnswer(kind) : runWithRuntime(runtime, ask)), cancellation]).then(answer => {
      send(child, { type: 'kkcode.prompt.response', id: message.id, answer: signal.aborted ? safeAnswer(kind) : answer })
    }, () => send(child, { type: 'kkcode.prompt.response', id: message.id, answer: safeAnswer(kind) })).finally(() => { pending.delete(message.id); signal.removeEventListener('abort', cancelled) })
  }
  const abort = () => { for (const controller of pending.values()) controller.abort() }
  child.on('message', receive)
  child.once('disconnect', abort)
  owner.controller.signal.addEventListener('abort', abort, { once: true })
  return () => { abort(); child.off('message', receive); child.off('disconnect', abort); owner.controller.signal.removeEventListener('abort', abort); releaseBackgroundPromptOwner(task.id) }
}

/** Worker side: disconnected/aborted/timed-out questions never imply consent. */
export function createBackgroundPromptClient(peer = process, { signal = null, timeoutMs = 300000 } = {}) {
  const pending = new Map()
  const settle = (id, answer) => {
    const row = pending.get(id)
    if (!row) return
    pending.delete(id); clearTimeout(row.timer); row.cleanup(); row.resolve(answer)
  }
  const receive = message => { if (message?.type === 'kkcode.prompt.response') settle(message.id, message.answer) }
  const close = () => { for (const [id, row] of pending) settle(id, safeAnswer(row.kind)) }
  peer.on('message', receive); peer.on('disconnect', close)
  const ask = (kind, request) => {
    if (!peer.send || peer.connected === false || signal?.aborted || request.signal?.aborted) return Promise.resolve(safeAnswer(kind))
    const id = randomUUID(), signals = [signal, request.signal].filter(Boolean)
    return new Promise(resolve => {
      const abort = () => { send(peer, { type: 'kkcode.prompt.cancel', id }); settle(id, safeAnswer(kind)) }
      const timer = setTimeout(abort, timeoutMs); timer.unref?.()
      const cleanup = () => { for (const item of signals) item.removeEventListener('abort', abort) }
      pending.set(id, { kind, resolve, timer, cleanup })
      for (const item of signals) item.addEventListener('abort', abort, { once: true })
      const { signal: ignored, ...payload } = request
      void ignored
      send(peer, { type: 'kkcode.prompt.request', id, kind, request: payload })
    })
  }
  return { onPermissionPrompt: request => ask('permission', request), onQuestionPrompt: request => ask('question', request), close() { close(); peer.off('message', receive); peer.off('disconnect', close) } }
}
