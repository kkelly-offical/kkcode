import { AsyncLocalStorage } from 'node:async_hooks'
import { loadPricing, calculateCost } from './pricing.mjs'
import { hasCompleteUsageEvidence, usageIdentity } from './usage-evidence.mjs'
import { randomUUID } from 'node:crypto'
import { resolveProviderConnection } from '../kernel/provider/model-catalog.mjs'
import { normalizeBudgetProfile, selectBudgetProfile } from './budget-profiles.mjs'

const budgets = new AsyncLocalStorage()
const fail = (code, message) => { throw Object.assign(new Error(message), { code, operationNotStarted: true }) }
const counters = ['input', 'output', 'cacheRead', 'cacheWrite']

/** Strict graph scope only. A zero ceiling does not grant a paid request. */
/** @param {{budgetUsd:number,deadlineAt:number,alreadySpent?:number,profiles?:any[],durable?:{reserve:Function,settle:Function}}} input @param {Function} run */
export async function withRequestBudget({ budgetUsd, deadlineAt, alreadySpent = 0, profiles = [], durable = undefined }, run) {
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0 || !Number.isSafeInteger(deadlineAt) || !Number.isFinite(alreadySpent) || alreadySpent < 0) fail('TASK_BUDGET_INVALID', '子任务预算或期限无效。')
  if (durable && (typeof durable.reserve !== 'function' || typeof durable.settle !== 'function')) fail('TASK_BUDGET_INVALID', '持久预算回调不完整。')
  if (durable && (!Array.isArray(profiles) || !profiles.length)) fail('BUDGET_PROFILE_REQUIRED', '持久请求预算缺少宿主批准的固定价格／窗口档案。')
  const frozenProfiles = profiles.map(profile => { const value = normalizeBudgetProfile(profile); Object.freeze(value.rates); return Object.freeze(value) })
  const state = { limit: budgetUsd, deadlineAt, spent: alreadySpent, reserved: 0, uncertain: false, durable, profiles: Object.freeze(frozenProfiles), closed: false }
  return budgets.run(state, async () => {
    try { return { result: await run(), costUsd: state.spent, uncertain: state.uncertain } }
    catch (error) { error.taskBudget = { costUsd: state.spent + state.reserved, uncertain: state.uncertain || state.reserved > 0 }; throw error }
    finally { state.closed = true }
  })
}
export const hasRequestBudget = () => Boolean(budgets.getStore())
export function assertRequestBudgetActive() {
  const state = budgets.getStore()
  if (!state) return
  if (state.closed || Date.now() >= state.deadlineAt) fail('TASK_DEADLINE', '任务作用域已关闭或期限已到，未发送计数或推理请求。')
  if (state.uncertain || state.spent + state.reserved >= state.limit) fail('TASK_BUDGET_EXHAUSTED', '任务预算已耗尽或费用未知，未发送计数或推理请求。')
}
export function assertRequestBudgetWithin({ budgetUsd, deadlineAt, durableRequired = false }) {
  const state = budgets.getStore()
  if (!state || state.closed || durableRequired && !state.durable || state.limit > budgetUsd || deadlineAt !== undefined && state.deadlineAt > deadlineAt) fail('TASK_BUDGET_SCOPE_REQUIRED', '严格预算需要宿主建立不超过已确认额度和期限的真实请求预算作用域。')
  if (state.uncertain || state.spent + state.reserved >= state.limit || Date.now() >= state.deadlineAt) fail('TASK_BUDGET_EXHAUSTED', '请求预算作用域已耗尽、过期或结果未知。')
}

/** Reserve at least both the approved context allowance and the complete
 * serialized/count-only input boundary; client caps cannot hide large inputs.
 * Strict budgets require known USD prices and disable blind transport retries.
 * @param {any} configState @param {{provider:string,model:string,contextLimit:number,maxTokens:number,inputTokenBound?:number,compaction?:boolean,requestId?:string,baseUrl?:string,credential?:string,protocol?:string}} input */
export async function reserveRequestBudget(configState, { provider, model, contextLimit, maxTokens, inputTokenBound = 0, compaction = false, requestId = randomUUID(), baseUrl, credential, protocol }) {
  const state = budgets.getStore()
  if (!state) return null
  if (state.closed || Date.now() >= state.deadlineAt) fail('TASK_DEADLINE', '子任务作用域已结束或持久期限已到，未发送新的模型请求。')
  if (state.uncertain || state.spent + state.reserved >= state.limit) fail('TASK_BUDGET_EXHAUSTED', '子任务预算已耗尽或上次计费结果未知，未发送新的模型请求。')
  if (!Number.isSafeInteger(contextLimit) || contextLimit <= 0 || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) fail('TASK_BUDGET_CONTEXT_UNKNOWN', '严格预算需要明确 context_limit 与最大输出 token 数。')
  let profile, quote, reservation
  if (state.profiles.length) {
    profile = selectBudgetProfile(state.profiles, { provider, model, protocol, baseUrl, credential })
    if (contextLimit > profile.contextLimit || maxTokens > profile.maxTokens || compaction && !profile.compaction) fail('BUDGET_PROFILE_REQUIRED', '请求扩大了已批准的窗口、输出或原生压缩能力；请重新审批任务。')
    if (inputTokenBound > profile.contextLimit) fail('BUDGET_INPUT_WINDOW', '本次完整输入超出已冻结的核价／上下文窗口，未发送推理。请精简输入，或新建经宿主确认更大窗口及该范围适用最高单价的任务；不会沿用旧单价静默跨越长上下文计费边界。Chat 字节上界可能保守，可使用支持精确计数的 Responses 渠道。')
    quote = usage => ({ amount: counters.reduce((sum, key) => sum + Number(usage[key] || 0) * profile.rates[key], 0), unknown: false })
    const inputRate = Math.max(profile.rates.input, profile.rates.cacheRead, profile.rates.cacheWrite)
    reservation = (profile.contextLimit * inputRate + maxTokens * profile.rates.output) * (compaction ? 2 : 1)
  } else {
    // Non-durable controlled diagnostics retain their existing helper behavior.
    // Every production strict coordinator supplies a private persisted profile.
    const configured = resolveProviderConnection(configState, provider)
    const changedScope = baseUrl !== undefined && baseUrl.replace(/\/$/, '') !== configured.baseUrl.replace(/\/$/, '') || credential !== undefined && credential !== configured.apiKey
    const { pricing, errors, source, strictPriceComplete, strictModelExact } = await loadPricing(configState, { providerName: provider, model, skipCatalog: changedScope })
    const rates = counters.map(counter => calculateCost(pricing, model, { [counter]: 1 }))
    if (errors.length || !strictPriceComplete || !strictModelExact || changedScope && source === 'default' || rates.some(rate => rate.unknown || rate.currency !== 'USD' || !Number.isFinite(rate.amount) || rate.amount < 0)) fail('TASK_BUDGET_PRICE_UNKNOWN', '职责模型缺少精确匹配 ID 的完整有效 USD 单价；前缀猜价及临时端点／凭据复用旧渠道目录价格均不能作为严格预留依据。')
    const inputRate = Math.max(rates[0].amount, rates[2].amount, rates[3].amount)
    if (inputTokenBound > contextLimit) fail('BUDGET_INPUT_WINDOW', '本次完整输入超过明确的核价／上下文窗口，未发送推理。请精简输入或明确批准更大窗口和该范围费率；不能通过低窗口参数隐藏真实输入。')
    reservation = (contextLimit * inputRate + maxTokens * rates[1].amount) * (compaction ? 2 : 1)
    quote = usage => calculateCost(pricing, model, usage)
  }
  if (state.spent + state.reserved + reservation > state.limit + Number.EPSILON * 32) fail('TASK_BUDGET_INSUFFICIENT', '剩余预算不足以覆盖本次完整输入和输出预留；请精简输入／工具定义、降低输出上限，或重新授权任务预算。仅缩小 context_limit 不会缩小实际输入。')
  // Async pricing loading may overlap another request; this check and increment
  // are adjacent synchronous operations within the host event loop.
  if (Date.now() >= state.deadlineAt || state.uncertain) fail('TASK_BUDGET_EXHAUSTED', '准备请求期间期限或计费状态变化。')
  state.reserved += reservation
  let receipt
  if (state.durable) {
    try { receipt = await state.durable.reserve({ requestId, amountUsd: reservation, provider, model, profileId: profile.id }) }
    catch (error) { state.uncertain = true; throw error }
  }
  let settled = false
  return {
    async cancelBeforeDispatch() {
      if (settled) return
      settled = true; state.reserved = Math.max(0, state.reserved - reservation)
      if (state.durable) {
        try { await state.durable.settle({ requestId, receipt, amountUsd: 0, status: 'settled' }) }
        catch (error) { state.uncertain = true; throw error }
      }
    },
    async settle(usage, { complete = false } = {}) {
      if (settled) return
      settled = true; state.reserved = Math.max(0, state.reserved - reservation)
      const identity = usageIdentity(usage)
      if (complete && hasCompleteUsageEvidence(usage) && (!identity || identity.model !== model || identity.tier != null && !['default', 'standard'].includes(identity.tier))) {
        state.spent += reservation; state.uncertain = true
        if (state.durable) await state.durable.settle({ requestId, receipt, amountUsd: null, status: 'unknown' })
        throw Object.assign(new Error('响应缺少真实模型身份，或实际模型／处理档位不符合已核价档案。请在渠道中选择实际返回的、已核价的固定版本模型 ID（alias 不能自动当作 dated snapshot），并使用默认处理档位。费用保留待核查，不自动重试，也不声称请求未发生。'), { code: 'BUDGET_PROVIDER_IDENTITY', operationNotStarted: false })
      }
      if (!complete || !hasCompleteUsageEvidence(usage) || !counters.every(counter => usage[counter] === undefined || Number.isSafeInteger(usage[counter]) && usage[counter] >= 0)
        || !counters.some(counter => typeof usage[counter] === 'number' && usage[counter] > 0)) {
        state.spent += reservation; state.uncertain = true
        if (state.durable) await state.durable.settle({ requestId, receipt, amountUsd: null, status: 'unknown' })
        return
      }
      const actual = quote(usage)
      state.spent += actual.amount
      if (actual.amount > reservation + Number.EPSILON * 32 || actual.unknown) state.uncertain = true
      if (state.durable) {
        // The durable authority records an over-reservation actual amount as
        // unknown itself, retaining the higher exposure rather than losing it.
        try { await state.durable.settle({ requestId, receipt, amountUsd: actual.amount, status: 'settled' }) }
        catch (error) { state.uncertain = true; throw error }
      }
    }
  }
}
