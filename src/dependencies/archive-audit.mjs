import {Worker} from 'node:worker_threads'

/** Shared bounded archive inspection, with no extraction or executable hooks. */
export async function auditPackageArchive(file, maxBytes, signal, {profile = 'dependency'} = {}) {
  if (!['dependency', 'plugin'].includes(profile) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024) throw new Error('Invalid archive inspection bounds')
  signal?.throwIfAborted()
  const worker = new Worker(new URL('./archive-worker.mjs', import.meta.url), {workerData: {file, maxBytes, profile}, env: {}, execArgv: [], resourceLimits: {maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2}})
  let timer, abort
  const failure = () => Object.assign(new Error('归档包含不安全链接、路径或不支持结构，未解包。'), {code: 'DEPENDENCY_ARCHIVE'})
  try {
    return await new Promise((resolve, reject) => {
      const done = (error, value = null) => {clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value)}
      abort = () => done(Object.assign(new Error('归档检查已取消。'), {code: 'DEPENDENCY_CANCELLED'}))
      timer = setTimeout(() => done(failure()), 15000)
      signal?.addEventListener('abort', abort, {once: true})
      if (signal?.aborted) abort()
      worker.once('message', value => value?.ok ? done(null, value) : done(failure()))
      worker.once('error', () => done(failure()))
      worker.once('exit', code => {if (code !== 0) done(failure())})
    })
  } finally {clearTimeout(timer); signal?.removeEventListener('abort', abort); await worker.terminate()}
}
