import { createHmac } from 'node:crypto'
import { roleProviderEndpoint } from './task-model.mjs'
import { resolveModelCapabilities, readCachedModelCatalog } from './model-catalog.mjs'
import { MODEL_CAPABILITY_KEYS } from './model-capabilities.mjs'
import { modelRuntimeProfile } from './runtime-parameters.mjs'

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
  const runtime = modelRuntimeProfile({ config }, { configKey: provider, model, protocol, baseUrl: endpoint })
  return {
    schemaVersion: 1, provider, model, protocol, endpointOrigin: new URL(endpoint).origin, scope,
    capabilities,
    continuity: { kind: protocol === 'responses' ? 'responses-native-output' : protocol === 'anthropic' && settings.native_compaction === true ? 'anthropic-completed-compaction-response' : 'none' },
    context: { ...runtime.context, estimated: runtime.context.source === 'fallback', catalogLimit: catalog?.modelParameters?.limits?.context || catalog?.modelParameters?.limits?.input || null,
      note: '模型目录声明、显式配置和估算来源分别标记；目录声明不代表当前端点已完成推理验证。' },
    output: runtime.output,
    thinking: runtime.thinking,
    catalog: { available: Boolean(catalog), fetchedAt: cached?.fetchedAt || null },
    compatibility: { endpointTested: false, note: '目录、配置和模型名称不是该端点已通过真实推理／工具协议验收的证明。Responses 精确计数需端点实际支持 /responses/input_tokens；不代表兼容网关已经支持。Chat 多模态没有通用严格计数保证。' }
  }
}
