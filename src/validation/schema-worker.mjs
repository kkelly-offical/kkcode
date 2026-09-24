import { parentPort } from 'node:worker_threads'
import { Ajv } from 'ajv'
import { Ajv2019 } from 'ajv/dist/2019.js'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const addFormats = createRequire(import.meta.url)('ajv-formats')
const engines = new Map(), cache = new Map()
function engine(dialect) {
  if (!engines.has(dialect)) {
    const Constructor = dialect === '2020-12' ? Ajv2020 : dialect === '2019-09' ? Ajv2019 : Ajv
    const instance = new Constructor({ strict: false, allErrors: false, coerceTypes: false, removeAdditional: false, validateFormats: true, addUsedSchema: false })
    addFormats(instance); engines.set(dialect, instance)
  }
  return engines.get(dialect)
}
parentPort.on('message', ({ id, schemaJson, dataJson, defaultDialect, compileOnly }) => {
  try {
    const schema = JSON.parse(schemaJson), uri = String(schema?.$schema || '')
    const dialect = uri.includes('2020-12') ? '2020-12' : uri.includes('2019-09') ? '2019-09' : uri ? 'draft-07' : defaultDialect
    const key = createHash('sha256').update(dialect).update(schemaJson).digest('hex')
    let validate = cache.get(key)
    if (!validate) {
      validate = engine(dialect).compile(schema); cache.set(key, validate)
      if (cache.size > 32) {
        // AJV retains compiled schemas internally. Bound both caches.
        cache.clear(); engines.clear(); cache.set(key, validate)
      }
    }
    if (validate.$async) throw new Error('Async schemas are not supported')
    if (!compileOnly && !validate(JSON.parse(dataJson))) parentPort.postMessage({ id, valid: false, code: 'schema_invalid', message: '数据不符合工具声明的 JSON Schema。' })
    else parentPort.postMessage({ id, valid: true })
  } catch {
    // Raw engine errors can embed URLs, credentials, regex/source or data.
    parentPort.postMessage({ id, valid: false, code: 'schema_compile', message: 'JSON Schema 无法编译；请检查方言、引用和约束。未忽略此校验。' })
  }
})
