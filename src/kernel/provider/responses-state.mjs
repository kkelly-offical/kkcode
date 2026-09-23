import { createHash } from 'node:crypto'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const responsesScope = input => hash([input.baseUrl, input.model, input.apiKey || ''])
const visible = content => (Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }])
  .filter(block => ['text', 'tool_use'].includes(block?.type))
  .map(block => block.type === 'text' ? { type: 'text', text: String(block.text || '').trim() } : block)
export const visibleResponseHash = content => hash(visible(content))

/** Opaque provider continuity is private history, not an instruction or UI row. */
export function attachResponsesState(content, state) {
  if (!state?.items?.length) return content
  const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }]
  const contentHash = visibleResponseHash(blocks)
  if (state.contentHash && state.contentHash !== contentHash) return content
  return [...blocks, { type: 'provider_state', protocol: 'responses', scope: state.scope, contentHash, items: state.items, reasoningTokens: state.reasoningTokens || 0 }]
}

export function replayResponsesState(content, scope) {
  const state = Array.isArray(content) && content.find(block => block?.type === 'provider_state' && block.protocol === 'responses' && block.scope === scope)
  if (!state || state.contentHash !== visibleResponseHash(content) || !Array.isArray(state.items)) return null
  return state.items
}

export function stripProviderState(messages) {
  return (Array.isArray(messages) ? messages : []).map(message => Array.isArray(message.content)
    ? { ...message, content: message.content.filter(block => block?.type !== 'provider_state') }
    : message)
}
