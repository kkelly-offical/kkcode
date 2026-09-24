import { validateJsonSchema } from '../tool/schema-validation.mjs'
import { McpError } from '../core/errors.mjs'

export async function validateMcpInput(tool, args, signal) {
  try {
    await validateJsonSchema({ schema: tool.inputSchema === undefined ? { type: 'object' } : tool.inputSchema, data: args, defaultDialect: '2020-12', signal })
    if (tool.outputSchema !== undefined) await validateJsonSchema({ schema: tool.outputSchema, compileOnly: true, defaultDialect: '2020-12', signal })
  } catch (error) {
    throw Object.assign(new McpError(`MCP 工具调用前 Schema 校验未通过：${error.message}`, { reason: 'invalid_arguments', validationCode: error.code }), { operationNotStarted: true })
  }
}

export async function validateMcpOutput(tool, result, signal) {
  if (tool.outputSchema === undefined || result?.isError === true) return
  try {
    if (result?.structuredContent === undefined) throw new Error('缺少 structuredContent。')
    await validateJsonSchema({ schema: tool.outputSchema, data: result.structuredContent, defaultDialect: '2020-12', signal })
  } catch (error) {
    throw new McpError(`MCP 返回的结构化结果未通过隔离 Schema 校验：${error.message} 操作可能已经完成，不会自动重试。`, { reason: 'bad_response', validationCode: error.code, knownOutcome: true })
  }
}
