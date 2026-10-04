import { estimateStringTokens, estimateTokenCount } from './compaction.mjs'
import { contextInputMessages } from './context-input.mjs'
import { resolveModelLimits } from '../provider/model-limits.mjs'

const count = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.ceil(Number(value)) : 0

/** The preflight and every client use the same complete request budget. */
/** @param {{system?: string | {text?: string, blocks?: Array<{text: string}>}, messages?: any[], tools?: any[], model: string, configState?: any, providerType?: string, baseUrl?: string | null, apiKeyEnv?: string | null, measuredTokens?: number | null, source?: string}} input */
export function requestContextBudget({ system = '', messages = [], tools = [], model, configState = null, providerType = '', baseUrl = null, apiKeyEnv = null, measuredTokens = null, source = 'estimated' }) {
  const systemText = typeof system === 'string' ? system : system?.text || system?.blocks?.map(block => block.text).join('\n\n') || ''
  const schema = tools.map(tool => ({ name: tool.name, description: tool.description || '', parameters: tool.inputSchema || {} }))
  const components = {
    system: estimateStringTokens(systemText),
    tools: estimateStringTokens(JSON.stringify(schema)),
    messages: estimateTokenCount(contextInputMessages({ messages, configState, providerType, model, baseUrl, apiKeyEnv }))
  }
  const estimated = Object.values(components).reduce((sum, value) => sum + value, 0)
  const measured = measuredTokens !== null && Number.isFinite(Number(measuredTokens)) && Number(measuredTokens) >= 0
  const tokens = measured ? count(measuredTokens) : estimated
  const limits = resolveModelLimits({ model, configState, providerType, baseUrl, apiKeyEnv })
  const { limit, outputReserved, inputBudget, windowKind, contextSource, outputSource } = limits
  const provider = configState?.config?.provider
  return {
    tokens, limit, outputReserved, inputBudget, windowKind, contextSource, outputSource,
    ...(limits.routeScope ? {routeScope:limits.routeScope} : {}),
    requiredTokens: tokens + (windowKind === 'input' ? 0 : outputReserved),
    ratio: limit > 0 ? Math.min(1, tokens / limit) : 0,
    percent: limit > 0 ? Math.min(100, Math.round(tokens * 100 / limit)) : 0,
    source: measured ? source : 'estimated', estimated: !measured || source === 'estimated' || source === 'strict-upper-bound',
    components, model, provider: providerType || provider?.default || '', updatedAt: Date.now()
  }
}
