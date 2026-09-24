const OPAQUE = new Set(['image', 'image_url', 'input_image', 'audio', 'audio_url', 'input_audio', 'video', 'video_url', 'document', 'file', 'input_file', 'redacted_thinking', 'item_reference'])
const fail = message => { throw Object.assign(new Error(message), { code: 'BUDGET_INPUT_UNBOUNDED', operationNotStarted: true }) }

/** Bound the client-controlled text payload including schemas/history/system,
 * not a user-tunable context cap or a language-dependent chars/token estimate.
 * UTF-8 bytes after raw/NFKC/NFKD normalization cover the supported common
 * byte/character tokenization profiles; doubling covers adapters that
 * serialize structured tool JSON once more. Explicit margins cover the known
 * protocol framing. Provider-hidden prefixes and dishonest counts remain an
 * external-provider contract, never a local guarantee about bank charges. */
export function strictInputTokenBound(input, { trustedCount = null } = {}) {
  let opaque = false, nodes = 0
  const seen = new WeakSet()
  function visit(value) {
    if (!value || typeof value !== 'object') return
    if (seen.has(value)) fail('输入包含循环引用，无法形成可验证的序列化预算。')
    seen.add(value)
    if (++nodes > 100000) fail('输入结构超过安全计数上限。')
    if (OPAQUE.has(value.type) || typeof value.encrypted_content === 'string' || typeof value.previous_response_id === 'string') opaque = true
    if (OPAQUE.has(value.type)) {
      const urls = [value.url, value.image_url, value.image_url?.url, value.video_url, value.video_url?.url, value.file_url, value.source?.url]
      if (urls.some(url => typeof url === 'string' && /^https?:/i.test(url))) fail('严格预算不能复用可变远程附件的计数；请先把图片／文件下载为已验证的固定附件，或使用 Browser 截图。未发送推理。')
    }
    for (const [key, child] of Object.entries(value)) {
      // Tool arguments are serialized reference data, not provider media parts.
      if (value.type === 'tool_use' && key === 'input') continue
      visit(child)
    }
    seen.delete(value)
  }
  const content = { system: input.system || '', messages: input.messages || [], tools: input.tools || [] }
  visit(content)
  let bytes, rawBytes
  try {
    const serialized = JSON.stringify(content)
    rawBytes = Buffer.byteLength(serialized)
    bytes = Math.max(rawBytes, Buffer.byteLength(serialized.normalize('NFKC')), Buffer.byteLength(serialized.normalize('NFKD')))
  } catch { fail('输入不能被完整序列化，无法核验费用预留。') }
  if (bytes > 16 * 1024 * 1024) fail('严格推理输入超过 16 MiB 安全计数限制。')
  const exact = Number.isSafeInteger(trustedCount) && trustedCount > 0 ? trustedCount : null
  if (opaque) {
    if (exact === null) fail('此请求包含媒体或不透明原生续接；该路由没有受支持的完整输入计数，严格预算拒绝发送。请切换到支持 /responses/input_tokens 的 Responses 渠道；普通交互会话不受此限制。')
    return { tokens: exact, bytes, rawBytes, method: 'provider-count-tokens', templateMargin: 0 }
  }
  if (exact !== null) return { tokens: exact, bytes, rawBytes, method: 'provider-count-tokens', templateMargin: 0 }
  const templateMargin = 4096 + 256 * ((input.messages?.length || 0) + (input.tools?.length || 0))
  return { tokens: Math.max(2 * bytes + templateMargin, exact || 0), bytes, rawBytes, method: 'serialized-normalized-utf8-upper-bound', templateMargin }
}

/** The exact same host-owned snapshot is counted and dispatched. A caller
 * changing history or tool schemas while count_tokens is in flight must not
 * lower the reservation for a later, larger payload. */
export function snapshotStrictInput(input) {
  let snapshot
  try {
    const serialized = JSON.stringify({ system: input.system, messages: input.messages,
      tools: input.tools?.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) })
    if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) fail('严格推理输入超过 16 MiB 安全计数限制。')
    snapshot = JSON.parse(serialized)
  } catch (error) { if (error.code === 'BUDGET_INPUT_UNBOUNDED') throw error; fail('输入不能被完整快照，无法核验费用预留。') }
  // This sentinel is structural validation only; it is never a token estimate.
  strictInputTokenBound(snapshot, { trustedCount: 1 })
  Object.assign(input, snapshot)
}

export function needsTrustedInputCount(input) {
  try { strictInputTokenBound(input); return false } catch (error) { if (error.code === 'BUDGET_INPUT_UNBOUNDED') return true; throw error }
}
