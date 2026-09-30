import path from 'node:path'
import { createHash } from 'node:crypto'
import { mkdir, lstat } from 'node:fs/promises'
import { readJson, writeJson } from '../../storage/json-store.mjs'
import { acquireProcessLock } from '../../storage/process-lock.mjs'
import { backgroundTaskCheckpointPath, backgroundTaskRuntimeDir } from '../../storage/paths.mjs'
import { INTERRUPTION_REASONS } from './interruption-reason.mjs'

const terminal = new Set(['completed', 'cancelled', 'error', 'interrupted'])
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

function validateId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,191}$/.test(id)) fail('background_task_id', 'Invalid background task checkpoint ID')
}

function privateLockStat(info, directory = false) {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || ![1, 2].includes(info.nlink)) ||
      process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    fail('background_task_lock_unsafe', 'Background task lock storage must be private and owned by this OS user')
  }
}

/** Every checkpoint writer shares this bounded, token-owned process lock. The
 * legacy tasks directory need not change permissions; only new lock metadata
 * lives in the owner-only .locks directory. A live owner is never evicted. */
export async function withBackgroundTaskLock(id, callback, { timeoutMs = 5000 } = {}) {
  validateId(id)
  const root = backgroundTaskRuntimeDir()
  await mkdir(root, { recursive: true })
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('background_task_lock_unsafe', 'Background task storage cannot be a symbolic link')
  const lockRoot = path.join(root, '.locks')
  await mkdir(lockRoot, { recursive: true, mode: 0o700 })
  privateLockStat(await lstat(lockRoot), true)
  const lockFile = path.join(lockRoot, `${createHash('sha256').update(id).digest('hex')}.lock`)
  const started = Date.now()
  let lease
  while (!lease) {
    for (const file of [lockFile, `${lockFile}.recovery`]) {
      try { privateLockStat(await lstat(file), file.endsWith('.recovery')) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    try { lease = await acquireProcessLock(lockFile) }
    catch (error) {
      if (error.code !== 'device_in_use') throw error
      if (Date.now() - started >= timeoutMs) fail('background_task_busy', 'Background task checkpoint is busy or its lock requires local inspection')
      await pause(10)
    }
  }
  try { return await callback() } finally { await lease.release() }
}

export async function readBackgroundTask(id) {
  validateId(id)
  const task = await readJson(backgroundTaskCheckpointPath(id), null)
  if (task && task.id !== id) fail('background_task_identity', 'Background task checkpoint identity does not match its filename')
  return task
}

export function backgroundTaskOwner(task) {
  return { attempt: Number(task?.attempt || 1), resumeToken: task?.resumeToken ?? null, childOperationId: task?.payload?.childOperationId ?? null }
}

export function backgroundTaskOwnerMatches(task, owner) {
  const current = backgroundTaskOwner(task)
  return Boolean(task) && current.attempt === owner.attempt && current.resumeToken === owner.resumeToken && current.childOperationId === owner.childOperationId
}

export async function createBackgroundTask(task) {
  return withBackgroundTaskLock(task.id, async () => {
    if (await readBackgroundTask(task.id)) fail('background_task_exists', 'Background task checkpoint already exists')
    await writeJson(backgroundTaskCheckpointPath(task.id), task)
    return task
  })
}

export async function updateBackgroundTask(id, updater, { owner = null, preserveTerminal = false, persist = writeJson } = {}) {
  return withBackgroundTaskLock(id, async () => {
    const current = await readBackgroundTask(id)
    if (!current) return { current: null, next: null }
    if (owner && !backgroundTaskOwnerMatches(current, owner)) fail('background_task_stale_owner', 'Background task attempt ownership changed')
    const patch = updater(current) || {}
    const next = { ...current, ...patch, _version: (current._version || 0) + 1, updatedAt: Date.now() }
    const sameAttempt = backgroundTaskOwnerMatches(next, backgroundTaskOwner(current))
    if (current.cancelled && sameAttempt) next.cancelled = true
    if (preserveTerminal && terminal.has(current.status)) {
      // Late worker heartbeat/log drains may retain evidence, never reopen or
      // replace an already settled attempt. Retry remains a manager operation.
      next.status = current.status
      next.cancelled = current.cancelled
      next.endedAt = current.endedAt
      next.interruptionReason = current.interruptionReason
      next.error = current.error
    } else if (current.cancelled && sameAttempt && terminal.has(next.status)) {
      next.status = 'cancelled'
      next.cancelled = true
      next.interruptionReason = INTERRUPTION_REASONS.USER_CANCEL
    }
    await persist(backgroundTaskCheckpointPath(id), next)
    return { current, next }
  })
}
