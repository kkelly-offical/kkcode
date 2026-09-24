import path from 'node:path'
import { readPinnedFile } from '../../src/util/pinned-io.mjs'
import { sha256 } from '../v1/manifest.mjs'

const sameIdentity = (trace, action) => trace.operationId === action.id && trace.kind === action.kind && trace.parameterHash === action.parameterHash
  && trace.invocationId === action.context?.invocationId && trace.sessionId === action.context?.sessionId && trace.turnId === action.context?.turnId
async function effect(cwd) {
  try { const bytes = await readPinnedFile(cwd, 'effect-once.txt', { maxBytes: 128 }); return { present: true, exact: bytes.equals(Buffer.from('once')), hash: sha256(bytes) } }
  catch (error) { if (error.code === 'ENOENT') return { present: false, exact: false, hash: null }; throw error }
}

export function createReceiptExecutionObserver(cwd) {
  const executions = [], requests = new Map()
  let boundary = null, fault = null
  const observer = {
    async before(input) {
      if (![input.operationId, input.invocationId, input.sessionId, input.turnId].every(value => typeof value === 'string' && value)) throw new Error('C10 actual execution trace is incomplete')
      const requested = input.args?.path
      const normalized = typeof requested === 'string' && requested.startsWith('/workspace/') ? `.${requested.slice('/workspace'.length)}` : requested
      const target = typeof normalized === 'string' && path.resolve(cwd, normalized) === path.join(cwd, 'effect-once.txt')
      return { operationId: input.operationId, invocationId: input.invocationId, sessionId: input.sessionId, turnId: input.turnId,
        kind: `tool.${input.tool.name}`, parameterHash: sha256(input.args || {}), target: input.tool.name === 'write' && target, before: await effect(cwd) }
    },
    async after(input, result, trace, error = null) {
      executions.push({ ...trace, after: await effect(cwd), completed: !error && result?.status !== 'error' && result?.status !== 'cancelled' && result?.ok !== false })
      if (!requests.has(input.operationId)) requests.set(input.operationId, input)
    },
    async bindEffect(runtime, input) {
      const last = executions.at(-1)
      if (!last?.target || !last.completed || last.before.present || !last.after.exact || last.operationId !== input.operationId) return
      const run = await runtime.store.getRun(runtime.run.id), action = run.actions.find(item => item.id === last.operationId)
      if (!action || action.state !== 'prepared' || !sameIdentity(last, action) || run.lastTurn?.status !== 'running'
        || action.context?.durableTurnId !== run.lastTurn.id) throw new Error('C10 effect must bind its actual pending durable operation')
      if (boundary) throw new Error('C10 effect was created more than once')
      boundary = { runId: run.id, ownerId: run.ownerId, ownerEpoch: run.ownerEpoch, action: structuredClone(action), afterEffect: last.after }
    },
    async matchReceipt(runtime, input, data) {
      if (!boundary || data.actionId !== boundary.action.id || !data.result || data.result.name !== 'write' || data.result.status !== 'completed'
        || input.source?.kind !== 'tool' || input.source.operationId !== boundary.action.id || input.actor?.runId !== boundary.runId) return false
      const run = await runtime.store.getRun(runtime.run.id), action = run.actions.find(item => item.id === boundary.action.id), actual = await effect(cwd)
      if (!action || action.state !== 'prepared' || run.ownerId !== boundary.ownerId || run.ownerEpoch !== boundary.ownerEpoch
        || action.context?.durableTurnId !== run.lastTurn?.id || !actual.exact || actual.hash !== boundary.afterEffect.hash) throw new Error('C10 target changed before its receipt fault')
      fault = { actionId: action.id, runId: run.id, ownerEpoch: run.ownerEpoch, durableTurnId: run.lastTurn.id,
        pendingState: action.state, sourceOperationId: input.source.operationId, afterEffect: actual, errorCode: 'ENOSPC' }
      return true
    },
    async replayEffect(runtime) {
      if (!boundary || !requests.has(boundary.action.id)) throw new Error('C10 replay requires the actual captured effect')
      // The real coordinator correctly aborted the original task. This explicit
      // offline fault bypasses only that stop fence to emulate a broken host
      // replay; it keeps the same operation identity, parameters and strict OCI.
      const signal = new AbortController().signal
      await runtime.backend.ensureReady({ cwd, contract: runtime.run.contract, signal })
      const result = await runtime.executeObservedFixtureTool({ ...requests.get(boundary.action.id), signal })
      if (result?.status === 'error' || result?.status === 'cancelled' || result?.ok === false) throw new Error('C10 replay fixture did not execute')
      return boundary.action.id
    },
    count() { return executions.length },
    async verify(run, { resumeError, beforeResume, afterResume }) {
      const final = await effect(cwd), selected = boundary ? executions.filter(item => item.operationId === boundary.action.id) : []
      const targetCalls = executions.filter(item => item.target), action = boundary && run.actions.find(item => item.id === boundary.action.id)
      const bound = Boolean(boundary && action && fault && run.id === boundary.runId && run.ownerId === boundary.ownerId && run.ownerEpoch === boundary.ownerEpoch
        && action.state === 'unknown' && fault.actionId === action.id && fault.pendingState === 'prepared' && fault.durableTurnId === action.context?.durableTurnId
        && executions.every(trace => { const current = run.actions.find(item => item.id === trace.operationId); return current && sameIdentity(trace, current) }))
      const checks = [
        { name: 'receipt-fault-bound-to-completed-target-effect', passed: bound && final.present && final.exact && selected.length > 0
          && selected[0].completed && !selected[0].before.present && selected[0].after.exact },
        { name: 'target-unknown-resume-refused-without-dispatch', passed: bound && resumeError === 'UNRESOLVED_ACTIONS' && beforeResume === afterResume },
        { name: 'bound-target-effect-not-reexecuted', passed: bound && selected.length === 1 && targetCalls.length === 1 && selected[0].completed }
      ]
      return { checks, evidence: { kind: 'bound-effect-receipt', boundary, fault, actualExecutions: structuredClone(executions),
        resume: { error: resumeError, beforeExecutions: beforeResume, afterExecutions: afterResume }, finalEffect: final } }
    }
  }
  return observer
}
