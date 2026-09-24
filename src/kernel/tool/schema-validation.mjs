import { Worker } from 'node:worker_threads'
import { types } from 'node:util'

const MAX_SCHEMA_BYTES = 256 * 1024, MAX_DATA_BYTES = 2 * 1024 * 1024
const MAX_WORKERS = 2, MAX_PENDING = 64, DEFAULT_TIMEOUT_MS = 3000
const queue = [], slots = new Set()
let sequence = 0
export class SchemaValidationError extends Error {
  constructor(code, message) { super(message); this.name = 'SchemaValidationError'; this.code = code }
}
const failure = (code, message) => new SchemaValidationError(code, message)

/** Bound before structured-clone; never invoke getters or toJSON hooks. */
export function boundedSchemaJson(value, maxBytes = MAX_SCHEMA_BYTES) {
  let bytes = 0, nodes = 0
  const seen = new Set()
  function visit(input, depth) {
    if (++nodes > 50000 || depth > 64) throw failure('schema_limit', 'Schema 或校验数据超过结构深度／节点上限。')
    if ((typeof input === 'object' && input !== null || typeof input === 'function') && types.isProxy(input)) throw failure('schema_data', 'Schema 校验不能接收 Proxy。')
    if (input === null || typeof input === 'boolean') { bytes += 5; return input }
    if (typeof input === 'number' && Number.isFinite(input)) { bytes += 24; return input }
    if (typeof input === 'string') {
      if (input.length > maxBytes) throw failure('schema_limit', 'Schema 或校验数据超过字节上限。')
      bytes += Buffer.byteLength(input) + 2
      if (bytes > maxBytes) throw failure('schema_limit', 'Schema 或校验数据超过字节上限。')
      return input
    }
    if (!input || typeof input !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(input)) || seen.has(input)) throw failure('schema_data', 'Schema 校验只接受无循环的 JSON 纯数据。')
    if (Array.isArray(input) && input.length > 50000) throw failure('schema_limit', '校验数组超过元素上限。')
    seen.add(input)
    const output = Array.isArray(input) ? [] : Object.create(null)
    for (const key of Object.keys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw failure('schema_data', 'Schema 校验数据不能包含 getter。')
      bytes += Buffer.byteLength(key) + 4
      if (bytes > maxBytes) throw failure('schema_limit', 'Schema 或校验数据超过字节上限。')
      if (descriptor.value === undefined) { if (Array.isArray(input)) output[key] = null; continue }
      output[key] = visit(descriptor.value, depth + 1)
    }
    seen.delete(input)
    return output
  }
  const json = JSON.stringify(visit(value, 0))
  if (Buffer.byteLength(json) > maxBytes) throw failure('schema_limit', 'Schema 或校验数据超过字节上限。')
  return json
}

export function snapshotToolArguments(args) { return JSON.parse(boundedSchemaJson(args ?? {}, MAX_DATA_BYTES)) }
function finish(job, error = null) {
  if (job.done) return
  job.done = true; clearTimeout(job.timer)
  job.signal?.removeEventListener('abort', job.abort)
  if (error) job.reject(error); else job.resolve()
}
function retire(slot, error) {
  if (slot.retiring) return
  slot.retiring = true
  if (slot.job) { finish(slot.job, error); slot.job = null }
  // Do not free concurrency until the non-cooperative thread really exits.
  void slot.worker.terminate().catch(() => {}).finally(() => { slots.delete(slot); pump() })
}
function createSlot() {
  const worker = new Worker(new URL('../../validation/schema-worker.mjs', import.meta.url), {
    env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 }
  })
  const slot = { worker, job: null, retiring: false }
  slots.add(slot)
  worker.on('message', message => {
    const job = slot.job
    if (!job || job.id !== message?.id || slot.retiring) return
    slot.job = null
    finish(job, message.valid === true ? null : failure(message.code || 'schema_invalid', message.message || 'Schema 校验未通过。'))
    worker.unref(); pump()
  })
  worker.on('error', () => retire(slot, failure('schema_worker', '隔离 Schema 校验线程异常结束，未跳过校验。')))
  worker.on('exit', () => { if (!slot.retiring) retire(slot, failure('schema_worker', '隔离 Schema 校验线程提前结束，未跳过校验。')) })
  worker.unref()
  return slot
}
function pump() {
  while (queue.length) {
    while (queue[0]?.done) queue.shift()
    if (!queue.length) return
    let slot = [...slots].find(item => !item.job && !item.retiring)
    if (!slot && slots.size < MAX_WORKERS) {
      try { slot = createSlot() } catch { finish(queue.shift(), failure('schema_worker', '无法启动隔离 Schema 校验，未回退到主线程。')); continue }
    }
    if (!slot) return
    const job = queue.shift()
    slot.job = job; job.slot = slot; slot.worker.ref()
    try { slot.worker.postMessage({ id: job.id, ...job.payload }) }
    catch { retire(slot, failure('schema_worker', '无法发送 Schema 校验请求，未执行工具。')) }
  }
}

/** Regex/$ref/composite compilation and execution stay entirely off-main-thread. */
export async function validateJsonSchema({ schema, data = null, defaultDialect = 'draft-07', compileOnly = false, signal = null, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (signal?.aborted) throw failure('schema_cancelled', 'Schema 校验已取消，未执行工具。')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw failure('schema_limit', 'Schema 校验超时配置无效。')
  if (queue.filter(job => !job.done).length + [...slots].filter(slot => slot.job).length >= MAX_PENDING) throw failure('schema_busy', '待校验任务已达到上限，请稍后重试。')
  const payload = { schemaJson: boundedSchemaJson(schema), dataJson: compileOnly ? 'null' : boundedSchemaJson(data, MAX_DATA_BYTES), defaultDialect, compileOnly }
  return new Promise((resolve, reject) => {
    const job = { id: ++sequence, payload, signal, resolve, reject, done: false, slot: null, timer: null, abort: null }
    const stop = (code, message) => {
      if (job.done) return
      const error = failure(code, message)
      if (job.slot) retire(job.slot, error)
      else { finish(job, error); pump() }
    }
    job.abort = () => stop('schema_cancelled', 'Schema 校验已取消，未忽略校验。')
    job.timer = setTimeout(() => stop('schema_timeout', 'Schema 校验超过时间上限，可能含高复杂度约束；已终止隔离线程，未自动重试。'), timeoutMs)
    signal?.addEventListener('abort', job.abort, { once: true })
    queue.push(job)
    if (signal?.aborted) job.abort(); else pump()
  })
}

/** Private SDK adapter hook only. The adapter owns mandatory worker validation
 * before and after callTool; never export this through the public SDK. */
export const deferredSdkSchemaValidator = Object.freeze({
  /** @template T @param {unknown} schema @returns {(data: unknown) => {valid: true, data: T, errorMessage: undefined}} */
  getValidator(schema) { boundedSchemaJson(schema); return data => ({ valid: true, data: /** @type {T} */ (data), errorMessage: undefined }) }
})
