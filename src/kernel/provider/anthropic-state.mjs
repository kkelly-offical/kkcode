import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const blocks = (content, trim = true) => (Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }])
  .filter(block => !['provider_state', 'reasoning', 'thinking', 'compaction'].includes(block?.type))
  .map(block => block?.type === 'text' ? { type: 'text', text: trim ? String(block.text || '').trim() : String(block.text || '') } : block)
  .filter(block => block?.type !== 'text' || block.text)
const historyHash = messages => hash(messages.map(message => ({ role: message.role, content: blocks(message.content, message.role === 'assistant') })))
const contentHash = content => hash(blocks(content))
const scope = input => hash(['kkcode.anthropic.compaction.v1', input.baseUrl.replace(/\/$/, ''), input.model])
const mac = (input, state) => createHmac('sha256', input.apiKey).update(JSON.stringify([
  state.protocol, state.scope, state.historyHash, state.contentHash, state.items
])).digest('hex')
const safeEqual = (left, right) => typeof left === 'string' && /^[a-f0-9]{64}$/.test(left)
  && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))

/** Only a completed, authenticated provider response may introduce native state.
 * Neither a pasted compaction block nor an edited/rewound history is authority
 * to discard prior messages. The MAC stays in private provider state; the
 * credential itself is never serialized into that state. */
export function createAnthropicState(input, items, visibleContent) {
  if (!input.apiKey || !items.some(item => item.type === 'compaction') || items.some(item => item.type === 'tool_use' && item.input?.__parse_error)) return null
  const state = {
    protocol: 'anthropic', scope: scope(input), historyHash: historyHash(input.messages),
    contentHash: contentHash(visibleContent), items: structuredClone(items)
  }
  return { ...state, mac: mac(input, state) }
}

export function attachAnthropicState(content, state) {
  if (state?.protocol !== 'anthropic' || state.contentHash !== contentHash(content)) return content
  const visible = Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }]
  return [...visible.filter(block => block?.type !== 'provider_state'), { type: 'provider_state', ...state }]
}

export function replayAnthropicState(input, index) {
  if (!input.apiKey || input.messages[index]?.role !== 'assistant') return null
  const content = input.messages[index].content
  const state = Array.isArray(content) && content.find(block => block?.type === 'provider_state' && block.protocol === 'anthropic')
  if (!state || state.scope !== scope(input) || !Array.isArray(state.items)
    || state.contentHash !== contentHash(content) || state.historyHash !== historyHash(input.messages.slice(0, index))) return null
  if (!state.items.some(item => item?.type === 'compaction' && typeof item.content === 'string' && item.content.trim())) return null
  if (!safeEqual(state.mac, mac(input, state))) return null
  return structuredClone(state.items)
}
