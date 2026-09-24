import { createHmac } from 'node:crypto'
import { roleProviderEndpoint } from './task-model.mjs'
import { resolveModelCapabilities, readCachedModelCatalog } from './model-catalog.mjs'
import { MODEL_CAPABILITY_KEYS } from './model-capabilities.mjs'
import { modelContextLimit } from '../session/compaction.mjs'
import { requestContextBudget } from '../session/context-budget.mjs'

/** Read-only, no inference or discovery request. Profile identity is exact
 * endpoint/protocol/model/credential scope, never just a marketing model name.
 * Public output contains the origin only; query/path/key bytes stay private. */
export async function resolveProviderProfile(configState, providerName = null, modelId = null) {
  const config = configState?.config || configState || {}
  const provider = providerName || config.provider?.default
  const settings = config.provider?.[provider] || {}
  const { protocol, endpoint } = roleProviderEndpoint(config, provider)
  const model = modelId || settings.default_model || ''
  const credential = settings.api_key || (settings.api_key_env ? process.env[settings.api_key_env] : '') || ''
  const scope = createHmac('sha256', credential || new URL(endpoint).search).update(JSON.stringify(['kkcode.provider-profile.v1', endpoint, protocol, model])).digest('hex')
  const resolved = await resolveModelCapabilities(configState, provider, model)
  const cached = await readCachedModelCatalog(configState, provider)
  const catalog = cached?.models?.find(item => item.id === model)
  const sources = { config: 'configuration', discovered: 'catalog', heuristic: 'inference' }
  const capabilities = Object.fromEntries(MODEL_CAPABILITY_KEYS.map(key => [key, {
    value: resolved.capabilities[key] ?? null, source: sources[resolved.sources[key]] || 'unknown'
  }]))
  capabilities.nativeCompaction = { value: protocol === 'anthropic' && settings.native_compaction === true, source: 'configuration' }
  capabilities.nativeStateContinuity = { value: protocol === 'responses' || protocol === 'anthropic' && settings.native_compaction === true, source: 'adapter' }
  capabilities.exactInputCounting = { value: protocol === 'responses', source: 'adapter' }
  const context = modelContextLimit(model, { config }, provider)
  const configuredContext = settings.context_limit > 0 || Object.entries(config.provider?.model_context || {}).some(([name, value]) => value > 0 && String(model).toLowerCase().startsWith(name.toLowerCase()))
  const budget = requestContextBudget({ model, configState: { config }, providerType: provider })
  return {
    schemaVersion: 1, provider, model, protocol, endpointOrigin: new URL(endpoint).origin, scope,
    capabilities,
    continuity: { kind: protocol === 'responses' ? 'responses-native-output' : protocol === 'anthropic' && settings.native_compaction === true ? 'anthropic-completed-compaction-response' : 'none' },
    context: { limit: context, source: configuredContext ? 'configuration' : 'inference', estimated: !configuredContext,
      catalogLimit: catalog?.contextLength || null, note: '配置预算可能包含此前应用的目录值；该数字本身不是端点实测证明。' },
    output: { reserved: budget.outputReserved, declaredLimit: Number(settings.max_output_tokens) || null, source: settings.max_output_tokens || settings.max_tokens ? 'configuration' : 'bounded-default' },
    catalog: { available: Boolean(catalog), fetchedAt: cached?.fetchedAt || null },
    compatibility: { endpointTested: false, note: '目录、配置和模型名称不是该端点已通过真实推理／工具协议验收的证明。Responses 精确计数需端点实际支持 /responses/input_tokens；不代表兼容网关已经支持。Chat 多模态没有通用严格计数保证。' }
  }
}
