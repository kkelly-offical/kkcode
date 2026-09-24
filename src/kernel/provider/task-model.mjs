import { ProviderError } from '../core/errors.mjs'
import { assertProviderDataPolicy } from '../permission/data-policy.mjs'
import { checkWorkspaceTrust } from '../permission/workspace-trust.mjs'
import { runtimeCwd } from '../core/runtime-context.mjs'

export const TASK_MODEL_ROLES = Object.freeze(['planning', 'implementation', 'review', 'compaction', 'title'])
const own = (value, key) => Object.hasOwn(value || {}, key)
const invalid = message => { throw new ProviderError(message, { reason: 'invalid_model_role' }) }

export function validateTaskModelRoles(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('models.roles 必须为职责配置对象。')
  for (const [role, selection] of Object.entries(value)) {
    if (!TASK_MODEL_ROLES.includes(role)) invalid('models.roles 包含未知职责。')
    if (selection === null) continue
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)
      || Object.keys(selection).some(key => !['provider', 'model'].includes(key))
      || ['provider', 'model'].some(key => typeof selection[key] !== 'string' || !selection[key].trim() || selection[key] !== selection[key].trim() || selection[key].length > 200 || /[\x00-\x1f\x7f]/.test(selection[key]))
      || ['__proto__', 'constructor', 'prototype'].includes(selection.provider)) invalid('模型职责必须明确指定 provider 配置名与 model，不能附带地址、凭据或自动回退。')
  }
}

/** Pure endpoint resolution for policy/diagnostics. Does not infer a different
 * provider from a model name and does not expose credentials. */
export function roleProviderEndpoint(config, providerName, override = null) {
  const provider = own(config.provider, providerName) && config.provider[providerName]
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) invalid('指定的职责模型渠道不存在。')
  const type = provider.type || providerName
  const protocol = type === 'openai-responses' ? 'responses' : provider.protocol || (type === 'anthropic' ? 'anthropic' : type === 'ollama' ? 'ollama' : 'openai')
  const dedicated = provider.endpoints?.[protocol]
  const raw = override || dedicated || provider.base_url
  try {
    const url = new URL(raw, !override && dedicated && provider.base_url ? `${provider.base_url.replace(/\/$/, '')}/` : undefined)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error()
    url.hash = ''
    return { protocol, endpoint: url.href.replace(/\/$/, '') }
  } catch { invalid('职责模型渠道的 Base URL 无效；不会回退到其他渠道。') }
}

/** An explicit role beats an explicitly supplied legacy stage model; otherwise
 * retain the current conversation route verbatim, never models.fast/default.
 * @param {any} configState
 * @param {{role: string, providerType?: string|null, model?: string|null, baseUrl?: string|null, apiKeyEnv?: string|null, legacyModel?: string|null}} input */
export async function resolveTaskModel(configState, { role, providerType = null, model = null, baseUrl = null, apiKeyEnv = null, legacyModel = null }) {
  if (!TASK_MODEL_ROLES.includes(role)) invalid('未知的模型职责。')
  const config = configState?.config || {}
  const conversationProvider = providerType || config.provider?.default
  const conversationModel = model || config.provider?.[conversationProvider]?.default_model || ''
  const roles = config.models?.roles
  if (roles !== undefined) validateTaskModelRoles(roles)
  const selection = roles?.[role]
  if (!selection) return { role, providerType: conversationProvider, model: legacyModel || conversationModel, baseUrl, apiKeyEnv, source: legacyModel ? 'legacy-stage' : 'conversation', overridden: false }

  const source = configState.source || {}
  const projectControlled = own(source.projectRaw?.models?.roles, role)
    || source.envScope !== 'user' && own(source.envOverlay?.models?.roles, role)
  if (projectControlled && !(await checkWorkspaceTrust({ cwd: source.cwd || runtimeCwd(), isTTY: false })).trusted) {
    throw new ProviderError('当前未信任的项目控制了职责模型选择。请检查 models.roles 后在该工作区执行 kkcode --trust；不会静默改用其他模型。', { reason: 'workspace_untrusted', role })
  }
  const changedProvider = selection.provider !== conversationProvider
  const route = { role, providerType: selection.provider, model: selection.model,
    baseUrl: changedProvider ? null : baseUrl, apiKeyEnv: changedProvider ? null : apiKeyEnv, source: 'configured-role', overridden: true }
  const actual = roleProviderEndpoint(config, route.providerType, route.baseUrl)
  assertProviderDataPolicy(configState, { providerName: route.providerType, baseUrl: actual.endpoint })
  return route
}
