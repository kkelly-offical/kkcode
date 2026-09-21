import { Ajv } from 'ajv'
import { Ajv2019 } from 'ajv/dist/2019.js'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { createRequire } from 'node:module'
const addFormats = createRequire(import.meta.url)('ajv-formats')
const options = { strict: false, allErrors: true, coerceTypes: false, removeAdditional: false, validateFormats: true }
const legacy = new Ajv(options), modern2019 = new Ajv2019(options), modern2020 = new Ajv2020(options)
for (const instance of [legacy, modern2019, modern2020]) addFormats(instance)
const validators = new WeakMap()
export function validateToolArguments(tool, args) {
  if (!tool.inputSchema) return
  let validate = validators.get(tool.inputSchema)
  if (!validate) {
    const dialect = String(tool.inputSchema.$schema || '')
    // MCP's default dialect is 2020-12. Existing unspecified local/builtin
    // definitions keep draft-07 compatibility; explicit dialects are honored.
    const ajv = dialect.includes('2020-12') || !dialect && String(tool.name).startsWith('mcp_') ? modern2020 : dialect.includes('2019-09') ? modern2019 : legacy
    validate = ajv.compile(tool.inputSchema); validators.set(tool.inputSchema, validate)
  }
  if (!validate(args)) throw new Error(`Invalid arguments for ${tool.name}: ${validate.errors.map(e => `${e.instancePath || '/'} ${e.message}`).join('; ')}`)
}
