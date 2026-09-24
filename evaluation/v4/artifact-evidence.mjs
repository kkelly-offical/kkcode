import { createHash } from 'node:crypto'
import { sha256 } from '../v1/manifest.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const sameAction = (trace, action) => action && trace.operationId === action.id && trace.kind === action.kind
  && trace.parameterHash === action.parameterHash && trace.invocationId === action.context?.invocationId
  && trace.sessionId === action.context?.sessionId && trace.turnId === action.context?.turnId
const refsOf = saved => [...new Map(saved.messages.flatMap(message => message.artifactRefs || []).map(ref => [ref.id, ref])).values()]
const actorFor = (runtime, run) => ({ ...runtime.actor, runId: run.id, sessionId: run.binding.sessionId })

/** Host-only observation of a generic archive/compaction/retrieval experiment.
 * No task catalog, expected answer, marker, or model-provided proof is read here.
 * The real broker calls before/after around each dispatch, serially. */
export function createArtifactRecoveryObserver() {
  const executions = [], requests = new Map()
  let clock = 0, boundary = null
  const observer = {
    async before(input) {
      if (![input.operationId, input.invocationId, input.sessionId, input.turnId].every(value => typeof value === 'string' && value)) throw new Error('Archive recovery requires an actual invocation identity')
      return { sequence: ++clock, operationId: input.operationId, invocationId: input.invocationId, sessionId: input.sessionId,
        turnId: input.turnId, kind: `tool.${input.tool.name}`, parameterHash: sha256(input.args || {}) }
    },
    async after(input, result, trace, error = null) {
      const completed = !error && result && !['error', 'cancelled', 'blocked'].includes(result.status) && result.ok !== false
      let read = null
      if (completed && input.tool.name === 'artifact_read') {
        try {
          const page = JSON.parse(result.output)
          if (page.id === input.args.artifact_id && typeof page.data === 'string' && ['base64', 'utf8'].includes(page.encoding)) {
            read = { id: page.id, sha256: page.sha256, size: page.size, offset: page.offset, encoding: page.encoding,
              dataHash: digest(page.data), cursor: input.args.cursor,
              limit: Math.min(Number(input.args.limit) || 4000, Math.max(1, Math.floor(((input.context?.toolResultLimit || 16000) - 1000) / 8))) }
          }
        } catch { /* A tool response that is not a real page is not evidence. */ }
      }
      executions.push({ ...trace, finishedSequence: ++clock, completed: Boolean(completed), read })
      if (!requests.has(input.operationId)) requests.set(input.operationId, input)
    },
    async bindCompression(runtime, { before, after, committed }) {
      if (boundary) throw new Error('Archive recovery compression boundary is already bound')
      const run = await runtime.store.getRun(runtime.run.id), current = await runtime.kernel.sessions.getSession(run.binding.sessionId)
      const valid = committed === true && after.messages.length < before.messages.length && sha256(current.messages) === sha256(after.messages)
      const retained = refsOf(after), sources = []
      if (valid) for (const ref of refsOf(before)) {
        if (!retained.some(next => next.id === ref.id && next.sha256 === ref.sha256 && next.size === ref.size)) continue
        let metadata
        try { metadata = await runtime.artifacts.getMetadata({ actor: actorFor(runtime, run), id: ref.id }) } catch { continue }
        if (metadata.sha256 !== ref.sha256 || metadata.size !== ref.size || metadata.source.kind !== 'tool') continue
        const producers = run.actions.filter(action => action.state === 'succeeded'
          && metadata.source.toolCallId === `call_${digest(action.context?.invocationId || '')}`
          && action.context?.sessionId === run.binding.sessionId
          && !['tool.artifact_read', 'tool.artifact_search'].includes(action.kind))
        if (producers.length !== 1) continue
        const producer = producers[0], observed = executions.filter(trace => sameAction(trace, producer))
        if (observed.length !== 1 || !observed[0].completed) continue
        sources.push({ ref: { id: ref.id, sha256: ref.sha256, size: ref.size }, producer: structuredClone(producer) })
      }
      boundary = { sequence: ++clock, runId: run.id, sessionId: run.binding.sessionId, ownerId: run.ownerId, ownerEpoch: run.ownerEpoch,
        committed: valid, beforeHash: sha256(before.messages), afterHash: sha256(after.messages), sources }
    },
    async verify(runtime) {
      const run = await runtime.store.getRun(runtime.run.id), sameOwner = boundary && run.id === boundary.runId
        && run.binding.sessionId === boundary.sessionId && run.ownerId === boundary.ownerId && run.ownerEpoch === boundary.ownerEpoch
      const bound = Boolean(sameOwner && boundary.committed && boundary.sources.length
        && executions.every(trace => sameAction(trace, run.actions.find(action => action.id === trace.operationId))))
      const reads = []
      if (bound) for (const trace of executions) {
        if (!trace.completed || trace.sequence <= boundary.sequence || trace.kind !== 'tool.artifact_read' || !trace.read) continue
        const source = boundary.sources.find(item => item.ref.id === trace.read.id && item.ref.sha256 === trace.read.sha256 && item.ref.size === trace.read.size)
        const action = run.actions.find(item => sameAction(trace, item) && item.state === 'succeeded')
        if (!source || !action) continue
        try {
          const page = await runtime.artifacts.read({ actor: actorFor(runtime, run), id: trace.read.id, cursor: trace.read.cursor, limit: trace.read.limit })
          const data = trace.read.encoding === 'base64' ? page.data : Buffer.from(page.data, 'base64').toString('utf8')
          if (page.sha256 === trace.read.sha256 && page.offset === trace.read.offset && digest(data) === trace.read.dataHash
            && Buffer.from(page.data, 'base64').length > 0) reads.push({ actionId: action.id, artifactId: page.id, sha256: page.sha256, offset: page.offset })
        } catch { /* Missing, corrupt, foreign, or stale artifacts fail closed. */ }
      }
      const restoredSources = bound ? boundary.sources.filter(source => reads.some(read => read.artifactId === source.ref.id)) : []
      // A fresh re-check of an unrelated diagnostic is not a replay of the
      // restored archive. Logical invocation IDs, however, are single-use even
      // when their tool happens to be readonly or unrelated to this experiment.
      const uniqueInvocations = new Set(executions.map(trace => trace.operationId)).size === executions.length
      const notReplayed = bound && uniqueInvocations && restoredSources.length > 0 && restoredSources.every(({ producer }) => {
        const original = executions.filter(trace => trace.operationId === producer.id)
        return original.length === 1 && original[0].completed && run.actions.some(action => sameAction(original[0], action) && action.state === 'succeeded')
          && !executions.some(trace => trace.sequence > boundary.sequence && trace.kind === producer.kind && trace.parameterHash === producer.parameterHash)
      })
      return { checks: [
        { name: 'actual-artifact-read-after-context-compression', passed: bound && reads.length > 0 },
        { name: 'bound-archive-producing-actions-not-reexecuted', passed: Boolean(notReplayed) }
      ], evidence: { kind: 'bound-artifact-recovery', boundary: structuredClone(boundary), actualExecutions: structuredClone(executions), verifiedReads: reads,
        restoredProducerIds: restoredSources.map(source => source.producer.id) } }
    },
    /** Offline negative control only; never invoked by normal/live grading. */
    async replayProducer(runtime, sourceArtifactId = null) {
      const producer = (sourceArtifactId ? boundary?.sources.find(source => source.ref.id === sourceArtifactId) : boundary?.sources[0])?.producer
      if (!producer || !requests.has(producer.id) || !runtime.executeObservedFixtureTool) throw new Error('Archive replay fixture lacks its actual original dispatch')
      await runtime.executeObservedFixtureTool(requests.get(producer.id))
      return producer.id
    }
  }
  return observer
}
