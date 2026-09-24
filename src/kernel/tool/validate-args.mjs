import { validateJsonSchema } from './schema-validation.mjs'

export async function validateToolArguments(tool, args, { signal = null, timeoutMs = undefined } = {}) {
  if (tool.inputSchema === undefined) return
  try {
    await validateJsonSchema({ schema: tool.inputSchema, data: args, defaultDialect: String(tool.name).startsWith('mcp_') ? '2020-12' : 'draft-07', signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
  } catch (error) {
    throw Object.assign(new Error(`Invalid arguments for ${String(tool.name || 'tool').slice(0, 128)}: ${error.message}`), { code: error.code, operationNotStarted: true })
  }
}
