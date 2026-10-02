import { responsesInput } from '../provider/responses.mjs'
import { resolveProviderRouteSettings } from '../provider/route-settings.mjs'

/** Estimate only the Responses items the adapter will replay. Display reasoning
 * remains in private history; native state, scope and signatures are untouched.
 * Other adapters may send reasoning_content and retain their existing estimate.
 * This projection is not a strict token count or a replacement for count_tokens. */
export function contextInputMessages({ messages, configState, providerType, model, baseUrl, apiKeyEnv }) {
  const providers = configState?.config?.provider
  const name = providerType || providers?.default
  const config = providers?.[name] || {}
  const type = config.type || name
  if (type !== 'openai-responses' && !(config.protocol === 'responses' && ['openai', 'openai-compatible', 'gateway'].includes(type))) return messages
  const route = resolveProviderRouteSettings(configState, name, { model, baseUrl, apiKeyEnv })
  const input = { ...route, messages, apiKey: route.apiKeyDirect || (route.apiKeyEnv ? process.env[route.apiKeyEnv] : '') || '' }
  let items
  try { items = responsesInput(input) } catch { return messages }
  let opaqueTokens = 0
  for (const message of messages) for (const state of Array.isArray(message.content) ? message.content : []) {
    if (state.type !== 'provider_state' || !Array.isArray(state.items) || !state.items.some(item => items.includes(item) && typeof item.encrypted_content === 'string')) continue
    const reported = Number(state.reasoningTokens)
    if (!Number.isFinite(reported) || reported <= 0) return messages
    opaqueTokens += reported
  }
  const projected = items.map(item => {
    if (item.type === 'reasoning') return { role: 'assistant', content: (item.summary || []).map(block => block.text || '').join('\n') }
    if (item.type === 'function_call') return { role: 'assistant', content: `${item.name} ${item.arguments}` }
    if (item.type === 'function_call_output') return { role: 'tool', content: String(item.output || '') }
    const content = Array.isArray(item.content) ? item.content.map(block =>
      block.type === 'input_image' ? { type: 'image' }
        : { type: 'text', text: String(block.text || block.refusal || '') }) : String(item.content || '')
    return { role: item.role || 'assistant', content }
  })
  return opaqueTokens ? [...projected, { role: 'assistant', content: [{ type: 'provider_state', reasoningTokens: opaqueTokens }] }] : projected
}
