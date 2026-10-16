import { validateToolArguments } from '../kernel/tool/validate-args.mjs'

const sensitive = /password|passwd|credential|secret|token|apikey|privatekey/
const sensitiveChinese = /密码|口令|私钥|密钥|令牌|凭据/
const ordinaryPatterns = [
  /^secret(?:ar(?:y|ies|ial(?:ly)?|iats?)|e(?:d|s)?|ing|ions?|ive(?:ly|ness)?|ly|ory)$/,
  /^token(?:iz(?:ers?|e(?:d|s)?|ing|ations?)|is(?:ers?|e(?:d|s)?|ing|ations?)|isms?|ist(?:s|ic(?:ally)?)?)$/,
  /^passwordless$/,
  /^(?:keyboards?|keynesians?|privatekeyboards?|apikeynesians?)$/
]
const isOrdinary = value => ordinaryPatterns.some(pattern => pattern.test(value))
const isSensitive = value => {
  const text = String(value || '')
  if (sensitiveChinese.test(text)) return true
  const tokens = []
  for (const word of text.match(/[A-Za-z]+/g) || []) {
    if (isOrdinary(word.toLowerCase())) continue
    const normalized = word.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
    for (const token of normalized.split(' ')) if (!isOrdinary(token)) tokens.push(token)
  }
  return tokens.some((token, index) => sensitive.test(token) || ((token === 'api' || token === 'private') && /^keys?/.test(tokens[index + 1] || '')))
}

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
    if (typeof question.id !== 'string' || question.secret === true || [question.id, question.text, question.header, question.description].some(isSensitive)) return { cancelled: true }
    const choices = (question.options || []).map(option => String(option.value ?? option.label)).slice(0, 100)
    if (question.allowCustom === false && !choices.length) return { cancelled: true }
    const field = { type: question.multi ? 'array' : 'string', title: String(question.text || question.id).slice(0, 1000), description: String(question.description || '').slice(0, 8000) }
    if (question.multi) field.items = { type: 'string' }
    if (question.allowCustom === false && choices.length) {
      if (question.multi) field.items.enum = choices
      else field.enum = choices
    }
    properties[`q${index}`] = field
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
