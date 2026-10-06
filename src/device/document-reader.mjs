import { Worker } from 'node:worker_threads'
import { ProtocolError } from '../protocol/index.mjs'

export const DOCUMENT_TYPES = new Set(['application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'])

/** Parsing is bounded and off the device event loop. No macros, links, formulas
 * or embedded programs are executed. Only extracted text enters model history. */
export function readDocument(data, mediaType) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./document-worker.mjs', import.meta.url), {
      workerData: { data, mediaType }, env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32 },
      stdout: true, stderr: true,
    })
    worker.stdout.resume(); worker.stderr.resume()
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer); void worker.terminate()
      error ? reject(new ProtocolError('document_read', error, 422)) : resolve(value)
    }
    const timer = setTimeout(() => finish('文档读取超时，请拆分文档后重试。'), 20000)
    worker.on('message', message => finish(message.error, message.text))
    worker.on('error', () => finish('无法读取文档，文件可能损坏或超出解析限制。'))
    worker.on('exit', () => { if (!settled) finish('文档读取未完成，请检查文件后重试。') })
  })
}
