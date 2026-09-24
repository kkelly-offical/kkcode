import { Ajv } from 'ajv'
import { createRequire } from 'node:module'
import { currentRuntime } from '../core/runtime-context.mjs'

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true })
const addFormats = createRequire(import.meta.url)('ajv-formats')
addFormats(ajv, { mode: 'fast' })
const secret = /password|passwd|api.?key|access.?token|refresh.?token|private.?key|client.?secret|credit.?card|密码|口令|私钥|密钥|支付卡/i
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const bounded = value => String(value ?? '').slice(0, 4000)
const cancel = () => ({ action: 'cancel' })

function cancellable(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('MCP 请求已取消'))
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function validateForm(params) {
  const schema = params.requestedSchema
  if (!plain(schema) || schema.type !== 'object' || !plain(schema.properties)) throw new Error('MCP 表单不是支持的扁平对象格式')
  if (JSON.stringify(schema).length > 32768) throw new Error('MCP 表单描述过大')
  const rootKeys = new Set(['type', 'properties', 'required', 'title', 'description', 'additionalProperties'])
  if (Object.keys(schema).some(key => !rootKeys.has(key)) || schema.additionalProperties != null && schema.additionalProperties !== false) throw new Error('不支持该 MCP 表单约束')
  if (schema.required != null && (!Array.isArray(schema.required) || schema.required.length > 16 || schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties, key)))) throw new Error('MCP 必填字段无效')
  const entries = Object.entries(schema.properties)
  if (!entries.length || entries.length > 16 || secret.test(String(params.message || ''))) throw new Error('MCP 表单过大或要求敏感凭据，已拒绝；请使用独立 OAuth 登录')
  const allowed = new Set(['type', 'title', 'description', 'default', 'minLength', 'maxLength', 'format', 'enum', 'enumNames', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'items', 'minItems', 'maxItems', 'uniqueItems'])
  const projected = Object.create(null)
  const checkEnum = values => Array.isArray(values) && values.length > 0 && values.length <= 100 && values.every(value => typeof value === 'string' && value.length <= 4000)
  for (const [name, field] of entries) {
    if (!plain(field) || ['__proto__', 'constructor', 'prototype'].includes(name) || secret.test(`${name} ${field.title || ''} ${field.description || ''}`)) throw new Error('MCP 表单要求不允许的敏感字段')
    // Never compile arbitrary server JSON Schema: regex, references and nested
    // compositions can block the event loop beyond any AbortSignal deadline.
    if (Object.keys(field).some(key => !allowed.has(key))) throw new Error('MCP 表单含不支持的 schema 关键字')
    if (!['string', 'number', 'integer', 'boolean', 'array'].includes(field.type)) throw new Error('MCP 表单含暂不支持的嵌套字段')
    if (field.enum !== undefined && !checkEnum(field.enum)) throw new Error('MCP 枚举字段超过限制')
    if (field.enumNames !== undefined && (!checkEnum(field.enumNames) || field.enumNames.length !== field.enum?.length)) throw new Error('MCP 枚举标题无效')
    if (field.format !== undefined && !['email', 'uri', 'date', 'date-time'].includes(field.format)) throw new Error('MCP 表单格式不受支持')
    for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) if (field[key] !== undefined && (!Number.isSafeInteger(field[key]) || field[key] < 0 || field[key] > (key.endsWith('Items') ? 100 : 65536))) throw new Error('MCP 表单长度约束超过限制')
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) if (field[key] !== undefined && !Number.isFinite(field[key])) throw new Error('MCP 数值约束无效')
    if (field.type === 'array') {
      if (!plain(field.items) || field.items.type !== 'string' || Object.keys(field.items).some(key => !['type', 'enum'].includes(key)) || !checkEnum(field.items.enum)) throw new Error('MCP 多选字段不受支持')
    } else if (field.items !== undefined) throw new Error('MCP 字段含不支持的子 schema')
    projected[name] = { ...field, ...(field.type === 'string' ? { maxLength: Math.min(field.maxLength ?? 65536, 65536) } : {}), ...(field.type === 'array' ? { maxItems: Math.min(field.maxItems ?? 100, 100) } : {}) }
  }
  return { entries, validate: ajv.compile({ type: 'object', properties: projected, required: schema.required || [], additionalProperties: false }) }
}

function valueFromAnswer(answer, schema) {
  const text = String(answer ?? '').trim()
  if (schema.type === 'string') return text
  if (schema.type === 'boolean') {
    if (['true', '是'].includes(text)) return true
    if (['false', '否'].includes(text)) return false
    throw new Error('布尔字段需要选择是或否')
  }
  if (schema.type === 'array') {
    const value = JSON.parse(text)
    if (!Array.isArray(value)) throw new Error('多选字段需要 JSON 数组')
    return value
  }
  if (!text || !Number.isFinite(Number(text))) throw new Error('数字字段需要有效数值')
  return Number(text)
}

/** Host-owned channel, never supplied by MCP arguments or server metadata.
 * Legacy server requests have no reliable parent id, so user operations on a
 * shared server are serialized. Each one captures its actual kernel channel.
 */
export function createMcpInteraction(serverName, { questionPrompt = null } = {}) {
  let queue = Promise.resolve(), active = null
  const inputQueues = new WeakMap()
  return {
    async run(method, signal, operation) {
      const channel = currentRuntime()?.questionPrompt || questionPrompt
      const runtime = currentRuntime()
      const pending = queue.then(async () => {
        signal?.throwIfAborted()
        const scope = { method, signal, channel, sessionId: runtime?.sessionId, rounds: 0 }
        active = scope
        try { return await operation() } finally { if (active === scope) active = null }
      })
      queue = pending.catch(() => {})
      // A queued cancelled request returns immediately, but keeps its queue
      // ticket until prior work drains. Later calls cannot steal its channel.
      return cancellable(pending, signal)
    },
    async elicit(params, requestSignal = null) {
      const scope = active
      if (!scope) return cancel()
      const previous = inputQueues.get(scope) || Promise.resolve()
      const next = previous.then(() => fulfill(scope, params, requestSignal))
      inputQueues.set(scope, next.catch(() => {}))
      return next
    }
  }
  async function fulfill(scope, params, requestSignal) {
      if (active !== scope) return cancel()
      if (!scope || scope.signal?.aborted || requestSignal?.aborted || !scope.channel?.hasPromptHandler?.() || ++scope.rounds > 10) return cancel()
      // URL mode is deliberately unadvertised: no automatic browser navigation,
      // login, sampling, credential forwarding or permission escalation here.
      if (params.mode && params.mode !== 'form') return { action: 'decline' }
      let form
      try { form = validateForm(params) } catch { return { action: 'decline' } }
      const signal = scope.signal && requestSignal ? AbortSignal.any([scope.signal, requestSignal]) : scope.signal || requestSignal
      const ask = async questions => {
        if (active !== scope || signal?.aborted) return {}
        const result = await scope.channel.askQuestionInteractive({ questions, sessionId: scope.sessionId, signal })
        return active === scope && !signal?.aborted ? result : {}
      }
      const actions = [{ label: '填写并审阅', value: 'accept', description: '仅向此 MCP 服务提交本次表单，不授予任何额外工具或文件权限' }, { label: '拒绝提供', value: 'decline', description: '告诉服务本次不提供信息' }, { label: '取消', value: 'cancel', description: '取消本次信息请求' }]
      const first = await ask([{ id: 'mcp_action', text: `MCP 服务「${bounded(serverName)}」请求用户输入`, description: `${bounded(params.message)}\n来源：${bounded(serverName)}；操作：${bounded(scope.method)}。请勿填写密码、API Key 或登录令牌。`, options: actions, allowCustom: false }])
      if (['decline', '拒绝提供'].includes(first.mcp_action)) return { action: 'decline' }
      if (!['accept', '填写并审阅'].includes(first.mcp_action)) return cancel()
      const answers = await ask(form.entries.map(([name, field], index) => ({ id: `mcp_field_${index}`, text: bounded(field.title || name), description: `${bounded(field.description)}${field.type === 'array' ? '\n请输入选项组成的 JSON 数组，例如 ["选项"]' : ''}${(params.requestedSchema.required || []).includes(name) ? '（必填）' : '（可留空）'}`, options: field.type === 'boolean' ? [{ label: '是', value: 'true' }, { label: '否', value: 'false' }] : (field.enum || []).map(value => ({ label: String(value), value: String(value) })), allowCustom: field.type !== 'boolean' && !field.enum })))
      const content = Object.create(null)
      try {
        for (let index = 0; index < form.entries.length; index++) {
          const [name, field] = form.entries[index]
          const raw = answers[`mcp_field_${index}`]
          if ((raw === undefined || raw === '') && !(params.requestedSchema.required || []).includes(name)) continue
          if (String(raw ?? '').length > 65536) return cancel()
          content[name] = valueFromAnswer(raw, field)
        }
        if (!form.validate(content)) return cancel()
      } catch { return cancel() }
      const final = await ask([{ id: 'mcp_submit', text: `向「${bounded(serverName)}」提交这些信息？`, description: JSON.stringify(content, null, 2), options: [{ label: '确认提交', value: 'submit' }, { label: '取消', value: 'cancel' }], allowCustom: false }])
      return ['submit', '确认提交'].includes(final.mcp_submit) ? { action: 'accept', content } : cancel()
  }
}
