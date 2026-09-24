import { validateToolArguments } from '../kernel/tool/validate-args.mjs'

const sensitive = /password|passwd|api.?key|access.?token|refresh.?token|private.?key|client.?secret|密码|口令|私钥|密钥/i

/** ACP support is explicit per mode (unlike MCP, elicitation:{} is NOT form).
 * The client handle and signal belong to this app connection + active turn.
 */
export async function requestAcpQuestion({ client, capabilities, sessionId, request, signal }) {
  if (capabilities?.elicitation?.form == null) return null
  if (signal?.aborted) return { cancelled: true }
  const questions = request.questions
  if (!Array.isArray(questions) || !questions.length || questions.length > 16) return { cancelled: true }
  const properties = Object.create(null), required = []
  for (let index = 0; index < questions.length; index++) {
    const question = questions[index]
    if (typeof question.id !== 'string' || sensitive.test(String(question.text || ''))) return { cancelled: true }
    const choices = (question.options || []).map(option => String(option.value ?? option.label)).slice(0, 100)
    properties[`q${index}`] = { type: 'string', title: String(question.text || question.id).slice(0, 1000), description: String(question.description || '').slice(0, 8000), ...(!question.multi && question.allowCustom === false && choices.length ? { enum: choices } : {}) }
    required.push(`q${index}`)
  }
  const schema = { type: 'object', properties, required }
  try {
    const response = await client.request('elicitation/create', { sessionId, mode: 'form', message: 'KK Code 需要你的输入。请检查并确认，拒绝或取消不会授予额外权限。', requestedSchema: schema }, { signal })
    if (signal?.aborted || response.action !== 'accept' || !response.content) return { cancelled: true }
    await validateToolArguments({ name: 'acp_user_question', inputSchema: { ...schema, additionalProperties: false } }, response.content, { signal })
    return Object.fromEntries(questions.map((question, index) => [question.id, response.content[`q${index}`]]))
  } catch { return { cancelled: true } }
}
