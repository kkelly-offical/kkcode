import { estimateStringTokens, estimateTokenCount, modelContextLimit } from './compaction.mjs'

const count = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.ceil(Number(value)) : 0

/** The preflight and every client use the same complete request budget. */
/** @param {{system?: string | {text?: string, blocks?: Array<{text: string}>}, messages?: any[], tools?: any[], model: string, configState?: any, providerType?: string, measuredTokens?: number | null, source?: string}} input */
export function requestContextBudget({ system = '', messages = [], tools = [], model, configState = null, providerType = '', measuredTokens = null, source = 'estimated' }) {
  const systemText = typeof system === 'string' ? system : system?.text || system?.blocks?.map(block => block.text).join('\n\n') || ''
  const schema = tools.map(tool => ({ name: tool.name, description: tool.description || '', parameters: tool.inputSchema || {} }))
  const components = {
    system: estimateStringTokens(systemText),
    tools: estimateStringTokens(JSON.stringify(schema)),
    messages: estimateTokenCount(messages)
  }
  const estimated = Object.values(components).reduce((sum, value) => sum + value, 0)
  const measured = measuredTokens !== null && Number.isFinite(Number(measuredTokens)) && Number(measuredTokens) >= 0
  const tokens = measured ? count(measuredTokens) : estimated
  const limit = modelContextLimit(model, configState, providerType)
  const provider = configState?.config?.provider
  const settings = provider?.[providerType || provider?.default] || {}
  const requestedOutput = count(settings.max_tokens) || Math.min(16384, Math.max(1, Math.floor(limit / 4)))
  const outputCap = count(settings.max_output_tokens) || requestedOutput
  const outputReserved = Math.min(requestedOutput, outputCap, Math.max(0, limit - 1))
  return {
    tokens, limit, outputReserved, inputBudget: Math.max(1, limit - outputReserved),
    requiredTokens: tokens + outputReserved,
    ratio: limit > 0 ? Math.min(1, tokens / limit) : 0,
    percent: limit > 0 ? Math.min(100, Math.round(tokens * 100 / limit)) : 0,
    source: measured ? source : 'estimated', estimated: !measured || source === 'estimated' || source === 'strict-upper-bound',
    components, model, provider: providerType || provider?.default || '', updatedAt: Date.now()
  }
}
