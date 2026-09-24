const FIELDS = new Set(['providers', 'model_origins', 'web_origins'])
export const DENY_DATA_POLICY = Object.freeze({ providers: Object.freeze([]), model_origins: Object.freeze([]), web_origins: Object.freeze([]) })

export class DataPolicyError extends Error {
  constructor(reason, field) {
    super(reason === 'data_policy_invalid'
      ? `数据出域策略无效（${field}）。已拒绝出站请求，请修正配置；该策略不会被忽略。`
      : `数据出域策略拒绝了此次请求（${field}）。请使用项目允许的模型渠道或目标站点；信任工作区不会解除此限制。`)
    this.name = 'DataPolicyError'
    this.code = reason
    this.details = { reason, field }
  }
}

function origin(value, field, originOnly = false) {
  try {
    if (typeof value !== 'string' || value !== value.trim()) throw new Error()
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
    if (originOnly && (url.pathname !== '/' || url.search || url.hash)) throw new Error()
    return url.origin
  } catch { throw new DataPolicyError('data_policy_invalid', field) }
}

/** Omission is unrestricted; an empty allowlist denies all. No wildcard grants. */
export function normalizeDataPolicy(value) {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DataPolicyError('data_policy_invalid', 'data_policy')
  const result = {}
  for (const key of Object.keys(value)) {
    if (!FIELDS.has(key)) throw new DataPolicyError('data_policy_invalid', 'data_policy: unknown field')
    const field = `data_policy.${key}`
    if (!Array.isArray(value[key]) || value[key].length > 256) throw new DataPolicyError('data_policy_invalid', field)
    result[key] = [...new Set(value[key].map(item => {
      if (key !== 'providers') return origin(item, field, true)
      if (typeof item !== 'string' || !item || item !== item.trim() || item.length > 128 || /[\s\x00-\x1f\x7f*]/.test(item)) throw new DataPolicyError('data_policy_invalid', field)
      return item
    }))]
  }
  return result
}

export function intersectDataPolicies(...values) {
  let result
  for (const value of values) {
    const policy = normalizeDataPolicy(value)
    if (policy === undefined) continue
    result ||= {}
    for (const key of Object.keys(policy)) {
      result[key] = result[key] === undefined ? [...policy[key]] : result[key].filter(item => policy[key].includes(item))
    }
  }
  return result
}

/** Retain inherited ceilings even when a caller supplies a changed effective
 * config. Project policy may tighten an untrusted workspace, never grant trust. */
export function effectiveDataPolicy(configOrState = {}) {
  if (!configOrState.config) return normalizeDataPolicy(configOrState.data_policy)
  const source = configOrState.source || {}
  return intersectDataPolicies(source.adminDataPolicy, source.userRaw?.data_policy,
    source.projectRaw?.data_policy, source.envOverlay?.data_policy,
    ...(source.envPolicyLayers || []).map(layer => layer.policy),
    configOrState.userConfig?.data_policy, configOrState.config.data_policy)
}

export function assertProviderDataPolicy(configState, { providerName, baseUrl }) {
  const policy = effectiveDataPolicy(configState)
  if (!policy) return
  if (policy.providers && !policy.providers.includes(providerName)) throw new DataPolicyError('data_policy_denied', 'providers')
  if (policy.model_origins) {
    const target = origin(baseUrl, 'model endpoint')
    if (!policy.model_origins.includes(target)) throw new DataPolicyError('data_policy_denied', 'model_origins')
  }
}

export function assertWebDataPolicy(configOrState, url) {
  const policy = effectiveDataPolicy(configOrState)
  if (!policy?.web_origins) return
  const target = origin(String(url), 'web endpoint')
  if (!policy.web_origins.includes(target)) throw new DataPolicyError('data_policy_denied', 'web_origins')
}
