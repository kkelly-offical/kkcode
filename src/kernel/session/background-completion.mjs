import path from 'node:path'
import { BackgroundManager } from '../orchestration/background-manager.mjs'
import { classifyVerificationCommand } from './completion-evidence.mjs'
import { normalizeToolOutcome } from '../tool/result-outcome.mjs'
import { runtimeCwd } from '../core/runtime-context.mjs'
import { reconcileCompletionEvents } from './completion-history.mjs'

const ACTIVE = new Set(['pending', 'running'])
const TERMINAL = new Set(['completed', 'error', 'cancelled', 'interrupted'])
const timestamp = value => Number.isSafeInteger(value) && value > 0 ? value : null
const taskId = value => typeof value === 'string' && /^bg_[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null
const check = (event, cwd) => event?.name === 'bash' && event.metadata?.verificationEnvUnknown !== true &&
  classifyVerificationCommand(event.args?.command, { cwd: path.resolve(cwd, event.args?.cwd || '.'), env: event.args?.env })
const completedMarker = part => part?.type === 'turn-outcome' && part.schema === 'kk.turn-outcome.v1' && part.source === 'host' && part.status === 'completed' && timestamp(part.createdAt)

function launch(event) {
  return event?.name === 'bash' && (event.metadata?.backgroundTask?.phase === 'submitted' ||
    event.args?.run_in_background === true && event.status === 'completed' && event.ok !== false)
}

function referencedTask(event) {
  if (!launch(event)) return null
  const structured = taskId(event.metadata?.backgroundTask?.id || event.background_task_id)
  if (structured) return structured
  // Legacy IDs are read only from a canonical host-recorded Bash launch, never
  // from arbitrary user text or a tool that merely mentions a task handle.
  return taskId(/\bbackground task launched: (bg_[A-Za-z0-9_-]+)/.exec(String(event.output || ''))?.[1])
}

function partEvent(part) {
  return { name: part.tool, args: part.args || {}, status: part.status, ok: part.status === 'completed',
    metadata: part.metadata || {}, output: part.output, turnId: part.turnId,
    startedAt: timestamp(part.startedAt), completedAt: timestamp(part.completedAt) || timestamp(part.createdAt) }
}

function successfulProcess(event) {
  const metadata = event?.metadata || {}
  return event?.status === 'completed' && event.ok !== false && !event.error && metadata.exitCode === 0 && metadata.started !== false &&
    !['timedOut', 'cancelled', 'captureIncomplete', 'terminationIncomplete', 'outcomeUnknown'].some(key => metadata[key] === true)
}

function receipt(task) {
  const outcome = normalizeToolOutcome(task.result)
  const raw = task.result, metadata = outcome.metadata
  // A historical string such as "tests passed" is not an exit receipt. The
  // old background runner swallowed exit status, so it cannot be upgraded.
  const actualProcess = raw && typeof raw === 'object' && !Array.isArray(raw) &&
    (Number.isInteger(metadata.exitCode) || metadata.exitCode === null) && typeof metadata.started === 'boolean' &&
    ['timedOut', 'cancelled', 'captureIncomplete'].every(key => typeof metadata[key] === 'boolean')
  const completedAt = timestamp(task.endedAt), startedAt = timestamp(task.startedAt)
  const unknown = !TERMINAL.has(task.status) || !actualProcess || !completedAt || !startedAt || startedAt > completedAt ||
    metadata.outcomeUnknown === true || metadata.terminationIncomplete === true
  const status = unknown ? 'error' : task.status === 'cancelled' ? 'cancelled'
    : task.status === 'completed' && outcome.ok ? 'completed' : 'error'
  return { name: 'bash', args: { command: task.payload.command, cwd: task.payload.cwd },
    status, ok: status === 'completed', turnId: task.payload.turnId || null, startedAt, completedAt,
    ...(task.error ? { error: String(task.error).slice(0, 500) } : {}),
    metadata: { ...metadata, ...(unknown ? { outcomeUnknown: true } : {}),
      // Environment values may contain credentials. They stay in the live
      // process closure, never copied into a persistent task checkpoint.
      ...(task.payload.envProvided ? { verificationEnvUnknown: true } : {}),
      backgroundTask: { id: task.id, kind: 'bash', phase: 'settled', status: task.status,
        parentSessionId: task.payload.parentSessionId || null, turnId: task.payload.turnId || null, completedAt } } }
}

function unknownEvent(reason, id = null) {
  return { name: 'background_completion', status: 'error', ok: false,
    metadata: { outcomeUnknown: true, reason, ...(id ? { backgroundTask: { id, phase: 'unknown' } } : {}) } }
}

function previouslyVerified(event, parts, cwd) {
  if (event.metadata.outcomeUnknown === true || !event.completedAt) return false
  const markers = parts.filter(part => completedMarker(part) && part.createdAt >= event.completedAt)
  if (!markers.length) return false
  // A completed background verification command is itself real check evidence.
  // Arbitrary commands instead require a later-starting foreground check.
  const verification = check(event, cwd)
  if (verification && successfulProcess(event)) return true
  return parts.some(part => {
    if (part?.type !== 'tool-call' || launch(partEvent(part))) return false
    const prior = partEvent(part)
    const laterCheck = check(prior, cwd)
    return successfulProcess(prior) && laterCheck && (!verification || laterCheck.id === verification.id) && prior.startedAt > event.completedAt &&
      prior.completedAt >= prior.startedAt && markers.some(marker => marker.createdAt >= prior.completedAt)
  })
}

/** Read canonical task records without waiting, stopping, replaying or changing
 * them. A launch is an acknowledgment, not completion. `toolEvents` and `parts`
 * must be host-owned records of this session, never model-authored evidence.
 * Returned events preserve input object identity (including reconciliation
 * brands) and order checks by their START against mutation COMPLETION times. */
/** @param {{sessionId?: string, toolEvents?: any[], parts?: any[], cwd?: string}} options */
export async function collectBackgroundCompletionEvidence({ sessionId, toolEvents = [], parts = [], cwd = runtimeCwd() } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Background completion requires a session owner')
  if (!Array.isArray(toolEvents) || !Array.isArray(parts)) throw new Error('Invalid background completion evidence')
  let lastCompleted = -1
  for (let index = 0; index < parts.length; index++) if (completedMarker(parts[index])) lastCompleted = index
  const sources = [...toolEvents, ...parts.slice(lastCompleted + 1).filter(part => part.type === 'tool-call' && part.status !== 'running').map(partEvent)]
  const references = new Map()
  for (const event of sources) {
    const id = referencedTask(event)
    if (id) references.set(id, event)
  }
  const missingLaunch = sources.some(event => launch(event) && !referencedTask(event))
  let tasks
  try { tasks = await BackgroundManager.list() }
  catch { return { pending: [], events: [...toolEvents, unknownEvent('background_store_unavailable')], unknown: true, needsFreshVerification: true } }
  const selected = new Map()
  for (const task of tasks) {
    if (typeof task?.payload?.command !== 'string' || task.payload.subSessionId) continue
    if (task.payload.parentSessionId === sessionId) selected.set(task.id, task)
    else if (!task.payload.parentSessionId && references.has(task.id)) {
      const source = references.get(task.id)
      // A legacy unowned record may be inspected only when its exact launch
      // ID and command are present in this session's canonical host record.
      if (source.args?.command === task.payload.command && (!source.args?.cwd || path.resolve(cwd, source.args.cwd) === path.resolve(task.payload.cwd))) selected.set(task.id, task)
    }
  }
  if (selected.size > 256) return { pending: [], events: [...toolEvents, unknownEvent('background_task_limit')], unknown: true, needsFreshVerification: true }
  const pending = [], events = toolEvents.filter(event => !launch(event))
  let unknown = missingLaunch, needsFreshVerification = false
  if (missingLaunch) events.push(unknownEvent('background_launch_receipt_missing'))
  for (const id of references.keys()) if (!selected.has(id)) { unknown = true; events.push(unknownEvent('background_record_missing_or_foreign', id)) }
  for (const task of selected.values()) {
    if (ACTIVE.has(task.status)) {
      pending.push({ id: task.id, status: task.status, turnId: task.payload.turnId || null,
        startedAt: timestamp(task.startedAt), createdAt: timestamp(task.createdAt) })
      continue
    }
    const event = receipt(task)
    const reconciliation = await reconcileCompletionEvents([event], sessionId)
    if (reconciliation.unavailable) {
      events.push(unknownEvent('operation_journal_unavailable', task.id)); unknown = true
      continue
    }
    if (reconciliation.requireChecks) needsFreshVerification = true
    if (previouslyVerified(event, parts, cwd)) continue
    events.push(event)
    if (event.metadata.outcomeUnknown === true) unknown = true
    if (event.metadata.started !== false && !check(event, cwd)) needsFreshVerification = true
  }
  if (selected.size || references.size) {
    const position = event => check(event, cwd) ? timestamp(event.startedAt) ?? -Infinity : timestamp(event.completedAt) ?? -Infinity
    events.sort((left, right) => {
      const delta = position(left) - position(right)
      if (!Number.isNaN(delta) && delta !== 0) return delta
      // Equality is not proof that a check began after the last write. Put
      // checks first so a same-millisecond settlement remains the later gate.
      return Number(Boolean(check(right, cwd))) - Number(Boolean(check(left, cwd)))
    })
  }
  const inspection = events.filter(event => event.metadata?.outcomeUnknown === true || event.metadata?.terminationIncomplete === true).slice(-20).map(event => ({
    tool: event.name,
    ...(typeof event.metadata?.operationId === 'string' ? {operationId: event.metadata.operationId} : {}),
    ...(event.metadata?.backgroundTask?.id ? {backgroundTaskId: event.metadata.backgroundTask.id} : {}),
    status: event.status
  }))
  return { pending, events, needsFreshVerification, unknown, inspection }
}
