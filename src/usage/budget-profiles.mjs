import { createHash, createHmac } from 'node:crypto'
import { loadPricing, calculateCost } from './pricing.mjs'
import { resolveProviderConnection } from '../kernel/provider/model-catalog.mjs'
import { roleProviderEndpoint, resolveTaskModel, TASK_MODEL_ROLES } from '../kernel/provider/task-model.mjs'
import { normalizeBudgetProfile } from '../storage/run-budget-profile.mjs'

const fail = message => { throw Object.assign(new Error(message), { code: 'BUDGET_PROFILE_REQUIRED', operationNotStarted: true }) }
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
export { normalizeBudgetProfile }

export function routeBudgetScope({ provider, model, protocol, baseUrl, credential = '' }) {
  const url = new URL(baseUrl)
  url.hash = ''
  const endpoint = url.href.replace(/\/$/, '')
  return createHmac('sha256', credential || url.search).update(JSON.stringify(['kkcode.approved-pricing.v1', provider, model, protocol, endpoint])).digest('hex')
}

export function budgetRoute(configState, { providerType, model, baseUrl = null, apiKeyEnv = null }) {
  const connection = resolveProviderConnection(configState, providerType)
  const config = configState.config.provider[connection.name], resolved = roleProviderEndpoint(configState.config, connection.name, baseUrl)
  const envName = apiKeyEnv ?? config.api_key_env ?? ''
  const credential = config.api_key || (envName ? process.env[envName] : '') || ''
  const route = { provider: connection.name, model: model || connection.defaultModel, protocol: resolved.protocol, baseUrl: resolved.endpoint, credential }
  return { ...route, scopeHash: routeBudgetScope(route), contextLimit: Number(config.context_limit), maxTokens: Number(config.max_tokens || 16384), compaction: config.native_compaction === true,
    changedScope: resolved.endpoint.replace(/\/$/, '') !== connection.baseUrl.replace(/\/$/, '') || credential !== connection.apiKey }
}

/** Only call before the task begins or inside a fresh real host confirmation.
 * Never call this loader on each request: the price file may be in a writable
 * task checkout. Persist the returned validated profile in the private ledger. */
export async function prepareBudgetProfile(configState, input) {
  const route = budgetRoute(configState, input)
  if (!route.model || !Number.isSafeInteger(route.contextLimit) || route.contextLimit <= 0 || !Number.isSafeInteger(route.maxTokens) || route.maxTokens <= 0) fail('模型缺少明确上下文窗口或输出上限，无法批准固定预算档案。')
  const { pricing, source, errors, strictPriceComplete, strictModelExact } = await loadPricing(configState, { providerName: route.provider, model: route.model, skipCatalog: route.changedScope })
  const counters = ['input', 'output', 'cacheRead', 'cacheWrite']
  const quoted = counters.map(counter => calculateCost(pricing, route.model, { [counter]: 1 }))
  if (errors.length || !strictPriceComplete || !strictModelExact || route.changedScope && source === 'default' || quoted.some(value => value.unknown || value.currency !== 'USD' || !Number.isFinite(value.amount) || value.amount < 0)) fail('固定预算档案需要完整且有效的 USD 单价和精确匹配的模型 ID；不会使用前缀／别名回退价格或其他地址／凭据的缓存价格。')
  const body = { version: 1, provider: route.provider, model: route.model, protocol: route.protocol, scopeHash: route.scopeHash,
    contextLimit: route.contextLimit, maxTokens: route.maxTokens, compaction: route.compaction,
    rates: Object.fromEntries(counters.map((counter, index) => [counter, quoted[index].amount])),
    source: source === 'default' ? 'built-in' : source === 'catalog' ? 'catalog' : 'manual' }
  const id = createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex')
  return normalizeBudgetProfile({ ...body, id })
}

export async function prepareBudgetProfiles(configState) {
  const config = configState.config, providerType = config.provider?.default
  const model = config.provider?.[providerType]?.default_model
  const routes = [{ providerType, model }]
  for (const role of TASK_MODEL_ROLES) routes.push(await resolveTaskModel(configState, { role, providerType, model }))
  for (const value of [config.models?.main, config.models?.fast, config.models?.subagent, ...Object.values(config.models?.ultra || {})]) {
    if (typeof value === 'string' && value.trim()) routes.push({ providerType, model: value })
  }
  const profiles = new Map()
  for (const route of routes) {
    const scope = budgetRoute(configState, route).scopeHash
    if (!profiles.has(scope)) profiles.set(scope, await prepareBudgetProfile(configState, route))
  }
  if (profiles.size > 32) fail('任务职责模型超过 32 个预算档案，请缩小范围。')
  return [...profiles.values()]
}

export function selectBudgetProfile(profiles, route) {
  const scopeHash = routeBudgetScope(route)
  const matches = profiles.filter(profile => profile.scopeHash === scopeHash && profile.provider === route.provider && profile.model === route.model && profile.protocol === route.protocol)
  if (matches.length !== 1) fail(matches.length ? '同一路由存在多份价格档案，必须明确选择；不会自动挑选较低价格。' : '本次路由没有宿主批准的持久价格档案。')
  return normalizeBudgetProfile(matches[0])
}
