import { fork } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { userRootDir } from './paths.mjs'
import { runStoreError } from './run-store-contracts.mjs'

/**
 * @typedef {{type: 'ready'} |
 * {type: 'startup_error', code: string, message: string} |
 * {type: 'reply', id: number, result?: unknown, error?: {code: string, message: string}}} RunStoreMessage
 */

/** @param {unknown} value @returns {RunStoreMessage | null} */
function parseWorkerMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = /** @type {Record<string, unknown>} */ (value)
  if (input.type === 'ready') return { type: 'ready' }
  if (input.type === 'startup_error') return {
    type: 'startup_error',
    code: typeof input.code === 'string' ? input.code : 'STORE_UNAVAILABLE',
    message: typeof input.message === 'string' ? input.message : 'Durable run storage is unavailable'
  }
  if (typeof input.id !== 'number' || !Number.isSafeInteger(input.id)) return null
  if (input.error !== undefined) {
    if (!input.error || typeof input.error !== 'object' || Array.isArray(input.error)) return null
    const error = /** @type {Record<string, unknown>} */ (input.error)
    if (typeof error.code !== 'string' || typeof error.message !== 'string') return null
    return { type: 'reply', id: input.id, error: { code: error.code, message: error.message } }
  }
  return { type: 'reply', id: input.id, result: input.result }
}

/** Keep experimental flags isolated from the CLI and supported on the minimum runtime. */
export function runStoreNodeArgs(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(version)
  if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 12)) throw runStoreError('UNSUPPORTED_RUNTIME', 'Durable runs require Node.js 22.12 or newer')
  const major = Number(match[1])
  const minor = Number(match[2])
  return (major === 22 && minor < 13) || (major === 23 && minor < 4) ? ['--experimental-sqlite'] : []
}

/**
 * SQLite lives in a dedicated child process. No arbitrary SQL crosses this boundary.
 * readOnly forbids application/schema writes, initialization, migration and chmod.
 * SQLite may create private WAL/SHM coordination files even for a read-only connection;
 * we deliberately do not unlink them or use immutable mode against concurrent writers.
 */
export async function openRunStore({ directory = path.join(userRootDir(), 'run-store'), requestTimeoutMs = 30_000, readOnly = false } = {}) {
  if (typeof directory !== 'string' || !directory.trim()) throw runStoreError('INVALID_INPUT', 'directory must be a local directory path')
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 300_000) throw runStoreError('INVALID_INPUT', 'requestTimeoutMs must be between 100 and 300000')
  if (typeof readOnly !== 'boolean') throw runStoreError('INVALID_INPUT', 'readOnly must be boolean')
  const worker = fork(fileURLToPath(new URL('./run-store-worker.mjs', import.meta.url)), [path.resolve(directory), readOnly ? 'read-only' : 'read-write'], {
    execArgv: runStoreNodeArgs(),
    // Do not propagate CLI loaders, NODE_OPTIONS, model keys or OAuth credentials.
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR', 'LANG'].includes(key))),
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json'
  })
  let nextId = 0
  let closed = false
  let closingPromise
  const pending = new Map()
  let resolveReady, rejectReady
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const startupTimer = setTimeout(() => {
    rejectReady(runStoreError('STORE_START_TIMEOUT', 'Durable run storage did not initialize'))
    worker.kill()
  }, requestTimeoutMs)
  const fail = (error) => {
    clearTimeout(startupTimer)
    closed = true
    rejectReady(error)
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error) }
    pending.clear()
  }
  worker.on('message', rawMessage => {
    const message = parseWorkerMessage(rawMessage)
    if (!message) return
    if (message.type === 'ready') { clearTimeout(startupTimer); resolveReady(); return }
    if (message.type === 'startup_error') {
      fail(runStoreError(message.code, message.message))
      worker.kill()
      return
    }
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(runStoreError(message.error.code, message.error.message))
    else request.resolve(message.result)
  })
  worker.on('error', () => fail(runStoreError('STORE_UNAVAILABLE', 'Durable run storage process could not start')))
  worker.on('exit', () => fail(runStoreError('STORE_CLOSED', 'Durable run storage stopped; a timed-out mutation must be checked before retrying')))
  const exited = new Promise(resolve => worker.once('exit', resolve))
  await ready.catch(async error => { worker.kill(); await exited; throw error })
  function request(method, input) {
    if (closed || !worker.connected) return Promise.reject(runStoreError('STORE_CLOSED', 'Durable run storage is closed'))
    const serialized = JSON.stringify(input ?? {})
    if (Buffer.byteLength(serialized) > 256 * 1024) return Promise.reject(runStoreError('INVALID_INPUT', 'Durable run request is too large'))
    return new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        // A timeout may have committed: fail the channel instead of pretending it failed safely.
        fail(runStoreError('STORE_OUTCOME_UNKNOWN', 'Storage reply timed out; reopen and inspect the operation before retrying'))
        worker.kill()
      }, requestTimeoutMs)
      pending.set(id, { resolve, reject, timer })
      worker.send({ id, method, input: input ?? {} }, error => {
        if (error) { fail(runStoreError('STORE_OUTCOME_UNKNOWN', 'Storage channel failed; inspect the operation before retrying')); worker.kill() }
      })
    })
  }
  return Object.freeze({
    createRun: input => request('createRun', input),
    getRun: runId => request('getRun', { runId }),
    listRuns: input => request('listRuns', input),
    claimRun: input => request('claimRun', input),
    transitionRun: input => request('transitionRun', input),
    requestControl: input => request('requestControl', input),
    beginTurn: input => request('beginTurn', input),
    endTurn: input => request('endTurn', input),
    prepareAction: input => request('prepareAction', input),
    settleAction: input => request('settleAction', input),
    setCandidate: input => request('setCandidate', input),
    recordVerification: input => request('recordVerification', input),
    reviseContract: input => request('reviseContract', input),
    events: input => request('events', input),
    getTaskGraph: input => request('getTaskGraph', input),
    listTaskGraphs: input => request('listTaskGraphs', input),
    updateTaskGraph: input => request('updateTaskGraph', input),
    getRunBudget: input => request('getRunBudget', input),
    configureRunBudget: input => request('configureRunBudget', input),
    approveRunBudgetProfile: input => request('approveRunBudgetProfile', input),
    reserveModelBudget: input => request('reserveModelBudget', input),
    settleModelBudget: input => request('settleModelBudget', input),
    reconcileModelBudget: input => request('reconcileModelBudget', input),
    createBackup: () => request('createBackup', {}),
    listBackups: () => request('listBackups', {}),
    verifyBackup: input => request('verifyBackup', input),
    restoreBackup: input => request('restoreBackup', input),
    /** Diagnostic PID, never an ownership credential. */
    workerPid: worker.pid,
    close() {
      closingPromise ??= (async () => {
        if (!closed) {
          const reply = request('close', {})
          closed = true
          try { await reply } finally { if (worker.connected) worker.disconnect() }
        }
        await exited
      })()
      return closingPromise
    }
  })
}
