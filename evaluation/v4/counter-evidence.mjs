import { readPinnedFile } from '../../src/util/pinned-io.mjs'
import { sha256 } from '../v1/manifest.mjs'

const identity = input => ({ operationId: input.operationId, invocationId: input.invocationId,
  sessionId: input.sessionId, turnId: input.turnId, kind: `tool.${input.tool.name}`, parameterHash: sha256(input.args || {}) })
const sameIdentity = (trace, action) => trace.operationId === action.id && trace.kind === action.kind
  && trace.parameterHash === action.parameterHash && trace.invocationId === action.context?.invocationId
  && trace.sessionId === action.context?.sessionId && trace.turnId === action.context?.turnId

export function parseCounterInteger(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 128) return null
  const text = bytes.toString('utf8').replace(/^[\t\r\n ]+|[\t\r\n ]+$/g, '')
  const value = /^[0-9]+$/.test(text) ? Number(text) : NaN
  return Number.isSafeInteger(value) ? value : null
}

// No model-written counter/evidence object is accepted. Read a bounded regular
// file through pinned directory handles, before and after each actual dispatch.
async function counter(cwd) {
  try {
    const bytes = await readPinnedFile(cwd, 'counter.txt', { maxBytes: 128 })
    return { present: true, value: parseCounterInteger(bytes), hash: sha256(bytes.toString('base64')) }
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false, value: 0, hash: null }
    throw error
  }
}

export function createCounterExecutionObserver(cwd) {
  const executions = [], requests = new Map(), subscriptions = { first: [], second: [] }
  let boundary = null
  const observer = {
    event(subscriber, event) {
      if (!['tool.start', 'tool.finish', 'tool.error'].includes(event.type)) return
      subscriptions[subscriber].push({ type: event.type, invocationId: event.payload?.invocationId, sessionId: event.sessionId, turnId: event.turnId })
    },
    async before(input) {
      const trace = identity(input)
      if (![trace.operationId, trace.invocationId, trace.sessionId, trace.turnId].every(value => typeof value === 'string' && value)) throw new Error('C04 actual execution trace is incomplete')
      return { ...trace, before: await counter(cwd) }
    },
    async after(input, result, trace, error = null) {
      const entry = { ...trace, after: await counter(cwd), completed: !error && result?.status !== 'error' && result?.status !== 'cancelled' && result?.ok !== false }
      executions.push(entry)
      if (!requests.has(entry.operationId)) requests.set(entry.operationId, input)
    },
    isIncrement(input) {
      const last = executions.at(-1)
      return last?.operationId === input.operationId && last.kind === 'tool.bash' && last.completed && last.before.value === 0 && last.after.value === 1
    },
    async bindBoundary(runtime, input) {
      const run = await runtime.store.getRun(runtime.run.id), action = run.actions.find(item => item.id === input.operationId)
      const trace = executions.at(-1)
      if (!action || action.state !== 'prepared' || !observer.isIncrement(input) || !sameIdentity(trace, action)
        || run.lastTurn?.status !== 'running' || action.context?.durableTurnId !== run.lastTurn.id) throw new Error('C04 reconnect must bind the actual increment while its receipt is pending')
      boundary = { runId: run.id, ownerId: run.ownerId, ownerEpoch: run.ownerEpoch, action: structuredClone(action) }
    },
    async replayIncrement(runtime, restoreValue) {
      if (!boundary || !requests.has(boundary.action.id)) throw new Error('C04 replay fault requires the actual captured increment')
      // An actual second isolated execution, not an asserted JSON counter.
      const result = await runtime.executeObservedFixtureTool(requests.get(boundary.action.id))
      if (result?.status === 'error' || result?.status === 'cancelled') throw new Error('C04 replay fixture did not execute')
      if (restoreValue) {
        const restored = await runtime.backend.runCommand({ cwd, command: 'node', args: ['-e', "require('node:fs').writeFileSync('counter.txt','1\\n')"], shell: false })
        if (restored.exitCode !== 0) throw new Error('C04 fixture counter restoration did not execute')
      }
      return boundary.action.id
    },
    async verify(run, { firstEvents, secondEvents, reattached }) {
      const final = await counter(cwd), original = boundary?.action
      const selected = original ? executions.filter(trace => trace.operationId === original.id) : []
      const changes = executions.filter(trace => trace.before.value !== trace.after.value)
      const boundEvents = subscriber => original ? subscriptions[subscriber].filter(event => event.invocationId === original.context.invocationId
        && event.sessionId === original.context.sessionId && event.turnId === original.context.turnId) : []
      const firstBound = boundEvents('first'), secondBound = boundEvents('second')
      const keys = new Set(), unique = executions.every(trace => { if (keys.has(trace.operationId)) return false; keys.add(trace.operationId); return true })
      const bound = Boolean(boundary && run.id === boundary.runId && run.ownerId === boundary.ownerId && run.ownerEpoch === boundary.ownerEpoch
        && original.state === 'prepared' && executions.every(trace => {
          const action = run.actions.find(item => item.id === trace.operationId)
          return action && sameIdentity(trace, action) && (trace.completed ? action.state === 'succeeded' : action.state !== 'succeeded')
        }))
      const checks = [
        { name: 'real-subscriber-reconnect-at-pending-increment', passed: bound && reattached === true && firstEvents > 0 && secondEvents > 0
          && firstBound.filter(event => event.type === 'tool.start').length === 1 && firstBound.every(event => event.type === 'tool.start')
          && secondBound.length === 1 && secondBound[0].type === 'tool.finish' },
        { name: 'bound-counter-invocation-not-reexecuted', passed: bound && unique && selected.length === 1 && selected[0].completed },
        { name: 'exactly-one-observed-counter-increment', passed: bound && changes.length === 1 && changes[0].operationId === original.id
          && changes[0].kind === 'tool.bash' && changes[0].before.value === 0 && changes[0].after.value === 1
          && executions.every(trace => trace.before.value !== null && trace.after.value !== null) && final.present && final.value === 1 }
      ]
      return { checks, evidence: { kind: 'bound-counter-invocation', boundary, actualExecutions: structuredClone(executions),
        subscriptions: { first: firstBound, second: secondBound }, finalCounter: final } }
    }
  }
  return observer
}
