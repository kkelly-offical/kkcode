import { listToolOperations } from '../tool/operation-journal.mjs'
import { toolCapability } from '../permission/rules.mjs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { restoreToolDispatchReceipt, restoreToolMutationReceipt } from '../core/execution-outcome.mjs'

const SCHEMA = 'kk.turn-outcome.v1'
const STATUSES = new Set(['running', 'completed', 'incomplete', 'cancelled', 'error'])
const TERMINAL_TOOL = new Set(['completed', 'error', 'blocked', 'cancelled'])
const reconciledEvents = new WeakSet()
const RECEIPT_FLAGS = ['exitCode', 'exitSignal', 'timedOut', 'cancelled', 'captureIncomplete', 'terminationIncomplete', 'outcomeUnknown', 'started', 'operationId']
const PATH_KEYS = ['path', 'filePath', 'file_path', 'from', 'to']
const ENV_NAMES = new Set(['CI', 'NODE_ENV', 'NO_COLOR', 'FORCE_COLOR', 'PYTHONDONTWRITEBYTECODE', 'CGO_ENABLED', 'LC_ALL', 'LANG'])
const environmentSnapshots = new WeakMap()
const hash = value => createHash('sha256').update(value).digest('hex')
const timestamp = value => Number.isSafeInteger(value) && value > 0 ? value : undefined

/** Hash only known non-routing overrides. Opaque reconstructed hashes are not
 * accepted: the history reader mints an in-process snapshot from canonical args.
 * @returns {Array<[string, string]>|null} */
export function completionEnvironmentIdentity(env) {
  if (env == null) return []
  if (typeof env !== 'object' || Array.isArray(env)) return null
  if (environmentSnapshots.has(env)) return environmentSnapshots.get(env)
  const prototype = Object.getPrototypeOf(env)
  if (prototype !== Object.prototype && prototype !== null) return null
  const entries = Object.entries(env)
  if (entries.length > ENV_NAMES.size || entries.some(([key, value]) => !ENV_NAMES.has(key) || typeof value !== 'string' || value.length > 4096)) return null
  return entries.sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => /** @type {[string, string]} */ ([key, hash(value)]))
}

function environmentSnapshot(env) {
  const identity = completionEnvironmentIdentity(env)
  const snapshot = Object.freeze({ kind: 'kk.completion.environment.v1', ...(identity ? { fingerprint: hash(JSON.stringify(identity)) } : { unsupported: true }) })
  environmentSnapshots.set(snapshot, identity)
  return snapshot
}

function backgroundReceipt(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.id !== 'string' || !/^bg_[A-Za-z0-9_-]{1,100}$/.test(raw.id)) throw new Error('invalid_background_receipt')
  const receipt = { id: raw.id }
  for (const key of ['kind', 'phase', 'status', 'parentSessionId', 'turnId']) if (raw[key] !== undefined) {
    if (raw[key] !== null && (typeof raw[key] !== 'string' || raw[key].length > 160)) throw new Error('invalid_background_receipt')
    receipt[key] = raw[key]
  }
  for (const key of ['startedAt', 'completedAt', 'createdAt']) if (timestamp(raw[key])) receipt[key] = raw[key]
  return receipt
}

/** Only this process-local host receipt can relax an acknowledged uncertainty;
 * a tool/plugin's self-reported operationAcknowledged boolean cannot do so. */
export const isReconciledCompletionEvent = event => reconciledEvents.has(event)

function typedMarker(part) {
  return part?.type === 'turn-outcome' && part.schema === SCHEMA && part.source === 'host' &&
    typeof part.turnId === 'string' && part.turnId.length > 0 && STATUSES.has(part.status)
}

function slimPaths(items) {
  if (!Array.isArray(items)) return undefined
  if (items.length > 128) throw new Error('too_many_change_paths')
  return items.map(item => {
    const value = {}
    for (const key of PATH_KEYS) if (typeof item?.[key] === 'string') {
      if (item[key].length > 4096) throw new Error('oversized_change_path')
      value[key] = item[key]
    }
    return value
  })
}

function slimEvent(part, cwd) {
  if (typeof part.tool !== 'string' || !part.tool || part.tool.length > 120) throw new Error('invalid_tool_identity')
  const args = {}, metadata = {}
  for (const key of ['command', 'cwd', ...PATH_KEYS]) if (typeof part.args?.[key] === 'string') {
    if (part.args[key].length > (key === 'command' ? 32768 : 4096)) throw new Error('oversized_tool_arguments')
    args[key] = part.args[key]
  }
  if (Array.isArray(part.args?.changes)) args.changes = slimPaths(part.args.changes)
  if (part.args?.env != null) args.env = environmentSnapshot(part.args.env)
  if (part.args?.run_in_background !== undefined) {
    if (typeof part.args.run_in_background !== 'boolean') throw new Error('invalid_background_flag')
    args.run_in_background = part.args.run_in_background
  }
  // Resolve historical checks in their actual saved workspace, never in the
  // new process's incidental cwd. No raw outputs/source bodies enter this view.
  if (typeof cwd === 'string') args.cwd = path.resolve(cwd, args.cwd || '.')
  for (const key of RECEIPT_FLAGS) if (part.metadata?.[key] !== undefined) {
    const value = part.metadata[key]
    const valid = key === 'exitCode' ? value === null || Number.isInteger(value)
      : key === 'exitSignal' ? value === null || typeof value === 'string' && value.length <= 80
        : key === 'operationId' ? typeof value === 'string' && value.length <= 160
          : typeof value === 'boolean'
    if (!valid) throw new Error('invalid_process_receipt')
    metadata[key] = value
  }
  for (const key of ['fileChanges', 'mutations']) if (Array.isArray(part.metadata?.[key])) metadata[key] = slimPaths(part.metadata[key])
  if (part.metadata?.mutation) metadata.mutation = slimPaths([part.metadata.mutation])[0]
  if (part.metadata?.backgroundTask) metadata.backgroundTask = backgroundReceipt(part.metadata.backgroundTask)
  if (part.metadata?.verificationEnvUnknown === true) metadata.verificationEnvUnknown = true
  const status = TERMINAL_TOOL.has(part.status) ? part.status : 'error'
  const event = { name: part.tool, args, status, ok: status === 'completed', metadata,
    turnId: part.turnId || null, historical: true,
    startedAt: timestamp(part.startedAt), completedAt: timestamp(part.completedAt) || (part.status !== 'running' ? timestamp(part.createdAt) : undefined) }
  if (part.status === 'running') {
    metadata.historyInterrupted = true
    if (!['read', 'search', 'safe-shell'].includes(toolCapability(part.tool, args.command, { args }))) metadata.outcomeUnknown = true
  }
  return restoreToolMutationReceipt(restoreToolDispatchReceipt(event, part.dispatch), part.mutationReceipt)
}

function inspection(reason, events = [], legacyUnverified = false) {
  return {
    toolEvents: [...events, { name: 'completion_history', status: 'error', ok: false, metadata: { completionHistoryIncomplete: true } }],
    requireChecks: true, unknown: true, needsInspection: true, legacyUnverified, reason
  }
}

/** Read-only reconstruction from canonical host parts. An old installation's
 * pre-marker conversations remain explicitly unverified, not retroactively
 * accepted and not imported wholesale into a new task's completion gate. */
export async function priorCompletionEvidence(entry, { maxEvents = 256, maxBytes = 262144, requireVerification = true } = {}) {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 4096 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 4 * 1024 * 1024) throw new Error('Invalid completion history bounds')
  const parts = Array.isArray(entry?.parts) ? entry.parts : []
  const firstMarker = parts.findIndex(typedMarker)
  if (firstMarker < 0) return { toolEvents: [], requireChecks: false, unknown: false, needsInspection: false, legacyUnverified: true }
  let start = firstMarker
  for (let index = firstMarker; index < parts.length; index++) {
    const marker = parts[index]
    // Answer completion does not clear unverified work for a strict caller.
    // Ordinary subsequent questions do not inherit a mandatory test backlog.
    if (typedMarker(marker) && marker.status === 'completed' &&
        (!requireVerification || marker.completionPolicy !== 'observational' || marker.verification?.passed === true)) start = index + 1
  }

  const relevant = [], running = new Map(), finished = new Set()
  for (let index = start; index < parts.length; index++) {
    const part = parts[index]
    if (part?.type !== 'tool-call') continue
    if (part.status === 'running') {
      if (typeof part.id !== 'string' || !part.id || running.has(part.id)) return inspection('ambiguous_running_tool_identity')
      running.set(part.id, { part, index })
    } else {
      if (!TERMINAL_TOOL.has(part.status)) return inspection('unknown_tool_status')
      if (part.runPartId) {
        if (finished.has(part.runPartId)) return inspection('duplicate_tool_outcome')
        const prior = running.get(part.runPartId)
        if (prior && (prior.part.tool !== part.tool || prior.part.turnId !== part.turnId)) return inspection('tool_outcome_identity_mismatch')
        running.delete(part.runPartId); finished.add(part.runPartId)
      }
      relevant.push({ part, index })
    }
    // The current unresolved window is never truncated to a suffix. Stop with
    // an explicit inspection barrier instead of dropping an old failure.
    if (relevant.length + running.size > maxEvents) return inspection('completion_history_event_limit')
  }
  relevant.push(...running.values())
  relevant.sort((a, b) => a.index - b.index)
  const events = []
  let bytes = 0
  try {
    for (const { part } of relevant) {
      const event = slimEvent(part, entry?.session?.cwd)
      bytes += Buffer.byteLength(JSON.stringify(event))
      if (bytes > maxBytes) return inspection('completion_history_byte_limit')
      events.push(event)
    }
  } catch { return inspection('completion_history_unrepresentable') }

  const reconciliation = await reconcileCompletionEvents(events, entry?.session?.id)
  if (reconciliation.unavailable) return inspection('operation_journal_unavailable', events)
  const unknown = events.some(event => event.metadata.outcomeUnknown === true || event.metadata.terminationIncomplete === true)
  return { toolEvents: events, requireChecks: reconciliation.requireChecks, unknown, needsInspection: false, legacyUnverified: false }
}

/** Shared foreground/background owner reconciliation. Acknowledgement is an
 * exact journal receipt, never a tool/plugin assertion or a later green test. */
export async function reconcileCompletionEvents(events, sessionId) {
  let operations = null, requireChecks = false
  for (const event of events) {
    const unknown = event.metadata.outcomeUnknown === true || event.metadata.terminationIncomplete === true
    if (!unknown) continue
    requireChecks = true
    const operationId = event.metadata.operationId
    if (typeof operationId !== 'string' || !operationId || !sessionId) continue
    if (!operations) {
      try { operations = await listToolOperations(sessionId) }
      catch { return {unavailable: true, requireChecks: true} }
    }
    const exact = operations.find(operation => operation.id === operationId && operation.tool === event.name && operation.turnId === event.turnId)
    if (exact?.state !== 'acknowledged') continue
    delete event.metadata.outcomeUnknown
    delete event.metadata.terminationIncomplete
    event.metadata.operationAcknowledged = true
    reconciledEvents.add(event)
  }
  return {requireChecks, unavailable: false}
}
