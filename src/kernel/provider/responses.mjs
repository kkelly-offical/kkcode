import { ProviderError } from '../core/errors.mjs'
import { buildRequestHeaders } from '../../http/identity.mjs'
import { annotateRetryAfter, primeRetriableStream, requestWithRetry, resolveRetryOptions } from './retry-policy.mjs'
import { parseSSE } from './sse.mjs'
import { replayResponsesState, responsesScope, visibleResponseHash } from './responses-state.mjs'

const MAX_STATE_BYTES = 4 * 1024 * 1024
const MAX_ITEMS = 512
const tokenCount = value => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0
export function responsesEndpoint(baseUrl) {
  let url
  try { url = new URL(baseUrl) } catch { throw new ProviderError('Responses Base URL 无效，请填写完整的 HTTP(S) API 地址。', { reason: 'invalid_config' }) }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new ProviderError('Responses Base URL 必须使用 HTTP(S)，且不能夹带账号密码。', { reason: 'invalid_config' })
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (!url.pathname.endsWith('/responses')) url.pathname += '/responses'
  url.hash = ''
  return url.href
}

function contentBlock(block) {
  if (block.type === 'image' && block.data) return { type: 'input_image', image_url: `data:${block.mediaType || 'image/png'};base64,${block.data}` }
  if (block.type === 'image_url') return { type: 'input_image', image_url: typeof block.image_url === 'string' ? block.image_url : block.image_url?.url }
  if (block.type === 'text') return { type: 'input_text', text: String(block.text || '') }
  if (['reasoning', 'thinking', 'provider_state'].includes(block.type)) return null
  throw new ProviderError(`Responses 当前不支持 ${String(block.type || 'unknown')} 输入；请使用文本/图片或切换到支持该媒体的协议。`, { reason: 'unsupported_capability' })
}

export function responsesInput(input) {
  const items = [], scope = responsesScope(input)
  for (const message of input.messages || []) {
    const state = message.role === 'assistant' && replayResponsesState(message.content, scope)
    if (state) { items.push(...state); continue }
    if (message.role === 'tool') { items.push({ type: 'function_call_output', call_id: message.tool_call_id, output: String(message.content || '') }); continue }
    if (!Array.isArray(message.content)) { items.push({ role: message.role, content: String(message.content || '') }); continue }
    let content = []
    const flush = () => { if (content.length) { items.push({ role: message.role, content: message.role === 'assistant' ? content.map(block => block.text || '').join('\n') : content }); content = [] } }
    for (const block of message.content) {
      if (block.type === 'tool_use') { flush(); items.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input || {}) }) }
      else if (block.type === 'tool_result') { flush(); items.push({ type: 'function_call_output', call_id: block.tool_use_id, output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '') }) }
      else { const mapped = contentBlock(block); if (mapped) content.push(mapped) }
    }
    flush()
  }
  return items
}

export function responsesPayload(input, stream = false) {
  const system = typeof input.system === 'string' ? input.system : input.system?.blocks?.map(block => block.text).join('\n\n') || input.system?.text || ''
  const reasoning = {
    ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
    ...(input.reasoningSummary && input.reasoningSummary !== 'off' ? { summary: input.reasoningSummary } : {})
  }
  return {
    model: input.model, instructions: system || undefined, input: responsesInput(input), store: false, stream,
    ...(input.tools?.length ? { tools: input.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false })), tool_choice: 'auto' } : {}),
    ...(input.maxTokens ? { max_output_tokens: input.maxTokens } : {}),
    ...(Object.keys(reasoning).length ? { reasoning, include: ['reasoning.encrypted_content'] } : {}),
    ...(Number.isFinite(input.temperature) ? { temperature: input.temperature } : {})
  }
}

function failure(input, status, value, message = 'Responses 请求失败') {
  const info = value?.error || value || {}
  let detail = String(info.message || info.code || '')
  if (input.apiKey) detail = detail.split(input.apiKey).join('[REDACTED]')
  detail = detail.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key|token|password|secret)([\s"']*[:=][\s"']*)[^\s"'&,;]+/gi, '$1$2[REDACTED]')
    .slice(0, 700)
  const error = /** @type {ProviderError & {httpStatus?: number, errorClass?: string}} */ (new ProviderError(`${message}${status ? `（HTTP ${status}）` : ''}${detail ? `：${detail}` : ''}`, { provider: input.provider || 'openai-responses', reason: 'bad_response' }))
  if (status) error.httpStatus = status
  else error.errorClass = ['server_error', 'rate_limit_exceeded'].includes(info.code) ? 'transient' : 'bad_request'
  return error
}

function nativeItems(output) {
  if (!Array.isArray(output) || output.length > MAX_ITEMS || Buffer.byteLength(JSON.stringify(output)) > MAX_STATE_BYTES) throw new ProviderError('Responses 输出格式无效或超过续接容量限制，请检查模型服务的兼容性。', { reason: 'bad_response' })
  return output.flatMap(/** @returns {Record<string, any>[]} */ item => {
    if (!item || typeof item !== 'object' || !Array.isArray(item.content ?? []) || !Array.isArray(item.summary ?? []) || [...(item.content || []), ...(item.summary || [])].some(block => !block || typeof block !== 'object')) throw new ProviderError('Responses 输出条目格式无效，请检查模型服务的兼容性。', { reason: 'bad_response' })
    if (item.type === 'message' && item.role === 'assistant') return [{ type: 'message', role: 'assistant', ...(item.id ? { id: item.id } : {}), ...(item.status ? { status: item.status } : {}), ...(item.phase ? { phase: item.phase } : {}), content: (item.content || []).filter(block => ['output_text', 'refusal'].includes(block.type)).map(block => block.type === 'refusal' ? { type: 'refusal', refusal: String(block.refusal || '') } : { type: 'output_text', text: String(block.text || ''), annotations: Array.isArray(block.annotations) ? block.annotations : [] }) }]
    if (item.type === 'reasoning') return [{ type: 'reasoning', ...(item.id ? { id: item.id } : {}), summary: (item.summary || []).filter(block => block.type === 'summary_text').map(block => ({ type: 'summary_text', text: String(block.text || '') })), ...(typeof item.encrypted_content === 'string' ? { encrypted_content: item.encrypted_content } : {}) }]
    if (item.type === 'function_call') return [{ type: 'function_call', ...(item.id ? { id: item.id } : {}), call_id: item.call_id, name: item.name, arguments: item.arguments, ...(item.status ? { status: item.status } : {}) }]
    if (String(item.type).endsWith('_call')) throw new ProviderError('Responses 返回了尚未支持的服务端托管工具，请使用 KK Code 受控 Function 工具。', { reason: 'unsupported_capability' })
    return []
  })
}

function citations(items, text) {
  const links = new Map()
  for (const item of items) for (const block of item.content || []) for (const annotation of block.annotations || []) {
    if (annotation.type !== 'url_citation') continue
    try {
      const url = new URL(annotation.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || text.includes(url.href)) continue
      links.set(url.href, String(annotation.title || url.hostname).replace(/[\[\]\\\r\n]/g, ' ').slice(0, 150))
    } catch { /* Invalid citations are not navigable sources. */ }
  }
  return links.size ? '\n\n来源：' + [...links].map(([url, title]) => `[${title}](<${url.replace(/[<>]/g, '')}>)`).join(' · ') : ''
}

export function parseResponsesResult(json, input) {
  if (!json || json.error || ['failed', 'cancelled'].includes(json.status)) throw failure(input, 0, json)
  if (!['completed', 'incomplete', undefined].includes(json.status)) throw failure(input, 0, {}, 'Responses 尚未完成，当前适配不使用后台轮询模式')
  const items = nativeItems(json.output)
  const calls = items.filter(item => item.type === 'function_call')
  if (new Set(calls.map(item => item.call_id)).size !== calls.length) throw failure(input, 0, {}, '模型返回了重复的工具调用 ID，未执行工具')
  if (json.status === 'incomplete' && calls.length || calls.some(item => item.status && item.status !== 'completed')) throw failure(input, 0, {}, '模型的工具调用未完整生成，未执行任何工具')
  if (json.status === 'incomplete' && json.incomplete_details?.reason !== 'max_output_tokens') throw failure(input, 0, {}, 'Responses 输出未完成或被服务端过滤，请检查输入与模型服务策略后重试')
  const toolCalls = calls.map(item => {
    if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || !item.name) throw failure(input, 0, {}, '模型返回的工具调用缺少关联 ID 或名称')
    let args
    try { args = JSON.parse(item.arguments || '{}'); if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid arguments') }
    catch { args = { __parse_error: true, __raw_length: String(item.arguments || '').length, __error: 'invalid JSON arguments' } }
    return { id: item.call_id, name: item.name, args }
  })
  const text = items.filter(item => item.type === 'message').flatMap(item => item.content || []).map(block => block.type === 'refusal' ? block.refusal : block.text || '').join('')
  const reasoning = items.filter(item => item.type === 'reasoning').flatMap(item => item.summary || []).map(block => block.text || '').join('\n')
  const sourceText = citations(items, text)
  const visibleContent = [...(text + sourceText ? [{ type: 'text', text: text + sourceText }] : []), ...toolCalls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args }))]
  const total = tokenCount(json.usage?.input_tokens), cached = Math.min(total, tokenCount(json.usage?.input_tokens_details?.cached_tokens))
  return {
    text: text + sourceText, reasoning, toolCalls,
    usage: { input: total - cached, output: tokenCount(json.usage?.output_tokens), cacheRead: cached, cacheWrite: 0 },
    stopReason: json.status === 'incomplete' ? json.incomplete_details?.reason === 'max_output_tokens' ? 'max_tokens' : 'content_filter' : toolCalls.length ? 'tool_use' : 'end_turn',
    providerState: { scope: responsesScope(input), items, contentHash: visibleResponseHash(visibleContent), reasoningTokens: tokenCount(json.usage?.output_tokens_details?.reasoning_tokens) }, sourceText
  }
}

async function connect(input, stream) {
  if (!input.apiKey && input.apiKeyEnv !== '') throw failure(input, 401, {}, '尚未配置 Responses API Key')
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), input.timeoutMs || 120000)
  try {
    const response = await fetch(responsesEndpoint(input.baseUrl), {
      method: 'POST', redirect: 'error', signal: input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal,
      headers: buildRequestHeaders({ target: 'llm', provider: input.provider || 'openai-responses', protocol: 'responses', requestId: input.requestId || '', openAIClientRequestId: true, accept: stream ? 'text/event-stream, application/json' : 'application/json', contentType: 'application/json', authorization: input.apiKey ? `Bearer ${input.apiKey}` : '' }),
      body: JSON.stringify(responsesPayload(input, stream))
    })
    try { input.onResponse?.(response) } catch { /* Telemetry cannot change execution. */ }
    if (!response.ok) {
      const body = await readJsonResponse(response, input).catch(() => ({}))
      throw annotateRetryAfter(failure(input, response.status, body), response)
    }
    return stream ? response : await readJsonResponse(response, input)
  } finally { clearTimeout(timer) }
}

async function readJsonResponse(response, input) {
  if (!response.body) throw failure(input, 0, {}, 'Responses 没有返回 JSON 内容')
  const reader = response.body.getReader(), chunks = []
  let size = 0, expired = false
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}) }, input.streamIdleTimeoutMs || input.timeoutMs || 120000)
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (expired) { const error = /** @type {Error & {code?: string}} */ (new Error('Responses response body timed out')); error.code = 'ETIMEDOUT'; throw error }
      if (done) break
      size += value.byteLength
      if (size > 8 * 1024 * 1024) throw failure(input, 0, {}, 'Responses JSON 超过 8 MiB 限制')
      chunks.push(Buffer.from(value))
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw failure(input, 0, {}, 'Responses 返回了无效 JSON') }
  } finally { clearTimeout(timer); try { await reader.cancel() } catch { /* Already closed. */ }; reader.releaseLock() }
}

export async function requestResponses(input) {
  return requestWithRetry({ ...resolveRetryOptions(input.retry), baseDelayMs: input.retry?.baseDelayMs ?? 800, signal: input.signal, onRetry: input.retry?.onRetry, execute: async () => {
    const json = await connect(input, false)
    return parseResponsesResult(json, input)
  } })
}

export async function* requestResponsesStream(input) {
  if (!input.retry?._streamPrimed) {
    const { iterator, first } = await primeRetriableStream({ ...resolveRetryOptions(input.retry), baseDelayMs: input.retry?.baseDelayMs ?? 800, signal: input.signal, onRetry: input.retry?.onRetry, create: () => requestResponsesStream({ ...input, retry: { _streamPrimed: true } }) })
    try { yield first.value; while (true) { const next = await iterator.next(); if (next.done) break; yield next.value } }
    finally { try { await iterator.return?.() } catch { /* Closing an interrupted stream. */ } }
    return
  }
  const response = await connect(input, true)
  if (response.headers.get('content-type')?.includes('application/json')) {
    const result = parseResponsesResult(await readJsonResponse(response, input), input)
    if (result.reasoning) yield { type: 'thinking', content: result.reasoning, source: 'reasoning_summary' }
    if (result.text) yield { type: 'text', content: result.text }
    for (const call of result.toolCalls) yield { type: 'tool_call', call }
    yield { type: 'provider_state', state: result.providerState }; yield { type: 'usage', usage: result.usage }; yield { type: 'stop', reason: result.stopReason }
    return
  }
  if (!response.body) throw failure(input, 0, {}, 'Responses 流没有响应体')
  const items = new Map()
  let terminal = null, text = '', reasoning = '', streamBytes = 0
  // Bound raw transport before SSE framing: a malformed endpoint can stream
  // data forever without a frame separator (and therefore without an event).
  const boundedBody = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
    streamBytes += chunk.byteLength
    if (streamBytes > 16 * 1024 * 1024) throw failure(input, 0, {}, 'Responses 流超过 16 MiB 限制')
    controller.enqueue(chunk)
  } }))
  for await (const { data } of parseSSE(boundedBody, input.signal, { idleTimeoutMs: input.streamIdleTimeoutMs || 120000 })) {
    let event
    try { event = JSON.parse(data) } catch { throw failure(input, 0, {}, 'Responses 流包含无效 JSON') }
    const index = event.output_index ?? event.item_id
    if (event.type === 'error' || event.type === 'response.failed') throw failure(input, 0, event.response || event)
    if (['response.completed', 'response.incomplete'].includes(event.type)) { terminal = { ...event.response, status: event.response?.status || (event.type === 'response.completed' ? 'completed' : 'incomplete') }; break }
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      if (event.item) items.set(index, event.item)
      if (items.size > MAX_ITEMS) throw failure(input, 0, {}, 'Responses 输出条目过多')
    } else if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      if (typeof event.delta === 'string' && event.delta) { text += event.delta; yield { type: 'text', content: event.delta } }
    } else if (['response.reasoning_summary_text.delta', 'response.reasoning_text.delta'].includes(event.type)) {
      if (typeof event.delta === 'string' && event.delta) { reasoning += event.delta; yield { type: 'thinking', content: event.delta, source: 'reasoning_summary' } }
    } else if (event.type === 'response.function_call_arguments.delta') {
      const item = items.get(index)
      if (item) item.arguments = String(item.arguments || '') + String(event.delta || '')
    } else if (event.type === 'response.function_call_arguments.done') {
      const item = items.get(index)
      if (item) item.arguments = event.arguments
    }
  }
  if (!terminal) {
    const error = /** @type {ProviderError & {errorClass?: string}} */ (failure(input, 0, {}, 'Responses 流在完成标记前中断，未执行未完成的工具调用'))
    error.errorClass = 'transient'; throw error
  }
  const output = terminal.output?.length ? terminal.output : [...items.values()]
  const result = parseResponsesResult({ ...terminal, output }, input)
  if (text && !result.text.startsWith(text)) throw failure(input, 0, {}, 'Responses 流式正文与最终结果不一致，已停止自动续接，请检查模型服务')
  if (!text && result.text) yield { type: 'text', content: result.text }
  else if (result.text.startsWith(text) && result.text.length > text.length) yield { type: 'text', content: result.text.slice(text.length) }
  if (!reasoning && result.reasoning) yield { type: 'thinking', content: result.reasoning, source: 'reasoning_summary' }
  for (const call of result.toolCalls) yield { type: 'tool_call', call }
  yield { type: 'provider_state', state: result.providerState }
  yield { type: 'usage', usage: result.usage }
  yield { type: 'stop', reason: result.stopReason }
}

// Keep estimates explicit; never emulate counting with a billable completion.
export async function countTokensResponses() { return null }
