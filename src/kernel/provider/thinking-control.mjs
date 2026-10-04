import { ProviderError } from '../core/errors.mjs'

const LABELS = { auto: ['自动', '使用服务端默认设置'], off: ['直答', '关闭思考'], none: ['直答', '关闭思考'],
  minimal: ['微思', '最轻思考'], low: ['略思', '较轻思考'], medium: ['审思', '仔细推敲'], high: ['深思', '深入推演'],
  xhigh: ['精思', '更缜密推演'], max: ['穷理', '更充分推究'], on: ['启思', '开启思考'] }
const RATIOS = { low: 0, medium: .25, high: .5, xhigh: .75, max: 1 }
const fail = message => { throw new ProviderError(message, { reason: 'invalid_thinking_parameter' }) }

// Kimi Code's catalog currently exposes context/media but omits effort fields.
// Bind this fallback to the documented service, protocol and exact model ID;
// another gateway using the same model name must supply its own capabilities.
// https://www.kimi.com/code/docs/kimi-code/models.html (2026-10-04)
function kimiCodeThinking(model, protocol, baseUrl) {
  if (!['openai', 'anthropic'].includes(protocol)) return null
  let url
  try { url = new URL(baseUrl) } catch { return null }
  if (url.protocol !== 'https:' || !['api.kimi.com', 'api.kimi.ai'].includes(url.hostname)
    || url.port || url.username || url.password || url.search || url.hash || !/^\/coding(?:\/v1)?\/?$/.test(url.pathname)) return null
  if (model === 'kimi-for-coding-highspeed') return { supported: true, alwaysOn: true }
  if (!['k3', 'k3-256k', 'kimi-for-coding'].includes(model)) return null
  return { supported: true, levels: ['none', 'low', 'high', 'max'],
    defaultLevel: model === 'kimi-for-coding' ? 'max' : 'high',
    aliases: { medium: 'high', xhigh: 'max', ultra: 'max', minimum: 'low', light: 'low' },
    offLabel: '直答（K2.8）', offDescription: '关闭思考；服务端改由 K2.8 Preview 无思考版处理' }
}

/** Public, credential-free UI contract; the same choices drive wire mapping.
 * @param {{model?: string, protocol?: string, baseUrl?: string, metadata?: any, settings?: any, maxTokens?: number}} input */
export function thinkingControl({ model = '', protocol = 'openai', baseUrl = '', metadata = {}, settings = {}, maxTokens = 0 } = {}) {
  let declared = metadata.reasoning || {}
  const specification = kimiCodeThinking(model, protocol, baseUrl)
  const declaredControl = declared.supported === false || declared.levels != null || declared.types?.length
    || declared.toggleParameter || declared.alwaysOn != null || declared.minBudget != null || declared.maxBudget != null
  const useSpecification = Boolean(specification && !declaredControl)
  if (useSpecification) declared = { ...declared, ...specification, defaultLevel: declared.defaultLevel ?? specification.defaultLevel }
  const preference = settings.model_options?.[model]?.thinking_effort ?? settings.thinking_effort ?? settings.reasoning_effort ?? 'auto'
  const alias = useSpecification && Object.hasOwn(specification.aliases || {}, preference) ? specification.aliases[preference] : preference
  const selected = preference === 'none' ? 'off' : alias
  const nativeLevels = { ...declared.nativeLevels }
  // Collapse documented aliases in the UI while retaining an explicitly
  // saved valid wire value. Selecting a new option stores its canonical value.
  if (useSpecification && selected !== preference && selected !== 'off') nativeLevels[selected] = preference
  let levels = declared.levels ? [...declared.levels] : null
  let types = declared.types || []
  let source = useSpecification ? 'specification' : declared.supported != null || levels || types.length || declared.toggleParameter ? 'catalog' : 'unknown'
  // Conservative compatibility knowledge for the original effort vocabulary.
  // Additional levels (notably xhigh/max) require declared capability.
  if (!levels && declared.supported !== false && /^(?:o[134](?:-|$)|gpt-5(?:-|$))/.test(model) && ['openai','responses'].includes(protocol)) {
    levels = ['low','medium','high']; source = 'fallback'
  }
  if (!types.length && protocol === 'anthropic' && /^claude-(?:3[.-]7|(?:opus|sonnet)-4(?:-|$)|haiku-4-5)/.test(model) && !levels && declared.supported !== false) {
    types = ['enabled','disabled']; source = 'fallback'
  }
  const toggleParameter = protocol === 'openai' ? declared.toggleParameter : null
  const canDisable = declared.alwaysOn !== true && Boolean(toggleParameter || protocol === 'anthropic' && types.includes('disabled') || levels?.some(v => ['off','none'].includes(v)))
  const nativeOff = levels?.includes('none') ? 'none' : levels?.includes('off') ? 'off' : null
  let kind = 'unknown', values = []
  if (declared.supported === false) kind = 'unsupported'
  else if (levels?.length) { kind = 'levels'; values = levels.filter(v => !['none','off'].includes(v)) }
  else if (protocol === 'anthropic' && (types.includes('enabled') || declared.minBudget)) { kind = 'budget'; values = Object.keys(RATIOS) }
  else if (toggleParameter || canDisable && protocol === 'anthropic' && types.includes('adaptive')) { kind = 'toggle'; values = ['on'] }
  else if (declared.alwaysOn === true || types.includes('adaptive')) kind = 'fixed'
  const minBudget = declared.minBudget || (protocol === 'anthropic' ? 1024 : 1)
  const budgetCeiling = Math.min(declared.maxBudget || Infinity, Math.floor(maxTokens * .9), maxTokens - 1)
  const budgetUnavailable = kind === 'budget' && budgetCeiling < minBudget
  if (budgetUnavailable) { kind = 'fixed'; values = [] }
  const budgetValues = {}
  if (kind === 'budget') {
    const unique = new Map()
    for (const value of values) {
      const tokens = minBudget + Math.floor((budgetCeiling - minBudget) * RATIOS[value])
      budgetValues[value] = tokens
      if (!unique.has(tokens) || value === selected) unique.set(tokens,value)
    }
    values = [...unique.values()]
  }
  const options = ['auto', ...(canDisable && kind !== 'unsupported' ? ['off'] : []), ...values]
    .map(value => ({ value, label: value === 'off' && declared.offLabel ? declared.offLabel : LABELS[value]?.[0] || value,
      description: value === 'off' && declared.offDescription ? declared.offDescription : LABELS[value]?.[1] || '模型原生档位', available: true,
      level: ['levels','budget'].includes(kind) && values.every(v => Object.hasOwn(RATIOS,v) || v === 'minimal') && values.includes(value) ? values.indexOf(value)+1 : null }))
  if (!options.some(option => option.value === selected)) options.push({ value: selected, label: `${LABELS[selected]?.[0] || selected} · 待确认`, description: '已保存设置，当前模型未确认支持', available: false, level: null })
  return { kind, source, selected, options, canDisable, nativeOff, types, nativeLevels, toggleParameter:toggleParameter || null,
    minBudget, maxBudget:declared.maxBudget || null, budgetValues, budgetUnavailable, budgetCeiling: Number.isFinite(budgetCeiling) ? Math.max(0, budgetCeiling) : 0,
    defaultLevel: declared.defaultLevel || null }
}

/** @param {{control: any, protocol: string, settings?: any, maxTokens: number}} input */
export function mapThinkingRequest({ control, protocol, settings = {}, maxTokens }) {
  const value = control.selected
  const explicit = settings.thinking
  if (explicit?.type) {
    if (protocol !== 'anthropic') fail('当前协议适配器不支持 thinking 对象，请使用自动或该模型支持的思考选项。')
    if (explicit.type === 'enabled') {
      if (!Number.isInteger(explicit.budget_tokens) || explicit.budget_tokens < control.minBudget || explicit.budget_tokens >= maxTokens || control.maxBudget && explicit.budget_tokens > control.maxBudget) fail('思考预算必须处于模型有效范围并小于本次输出额度。')
      return { thinking: { type: 'enabled', budget_tokens: explicit.budget_tokens } }
    }
    if (!['adaptive','disabled'].includes(explicit.type)) fail('当前协议不支持该思考模式。')
    if (explicit.type === 'disabled' && control.types.includes('adaptive') && !control.canDisable) fail('当前模型不支持关闭思考。')
    return { thinking: { type: explicit.type } }
  }
  if (value === 'auto') return {}
  if (control.budgetUnavailable && value !== 'off') fail('本次输出额度不足以启用所选思考档位。')
  if (!['openai','responses','anthropic'].includes(protocol)) fail('当前协议适配器尚不支持手动思考参数，请使用自动。')
  const option = control.options.find(item => item.value === value)
  if (option?.available === false && ['catalog', 'specification'].includes(control.source)) fail(`当前模型不支持已选择的思考档位 ${value}，请重新选择或使用自动。`)
  if (control.kind === 'unsupported') fail('当前模型不支持思考参数，请使用自动设置。')
  if (control.toggleParameter && ['off','on'].includes(value)) return { thinkingSwitch:{parameter:control.toggleParameter,enabled:value === 'on'} }
  if (value === 'off') {
    if (!control.canDisable && control.source !== 'unknown') fail('当前模型未声明可关闭思考。')
    return protocol === 'anthropic' ? { thinking: { type: 'disabled' } } : { reasoningEffort: (control.nativeOff ? control.nativeLevels[control.nativeOff] : null) || control.nativeOff || 'none' }
  }
  if (control.kind === 'budget') {
    const budget = control.budgetValues[value]
    if (!Number.isInteger(budget) || budget < control.minBudget || budget >= maxTokens || budget > control.budgetCeiling) fail('本次输出额度不足以启用所选思考档位。')
    return { thinking: { type: 'enabled', budget_tokens: budget } }
  }
  if (control.kind === 'toggle') {
    if (protocol === 'anthropic' && control.types.includes('adaptive')) return { thinking: { type: 'adaptive' } }
    // A boolean capability alone does not identify a wire parameter.
    fail('接口尚未提供可用的思考开关参数，请使用自动设置。')
  }
  const native = control.nativeLevels[value] || value
  if (protocol === 'anthropic') return { ...(control.types.includes('adaptive') ? { thinking: { type: 'adaptive' } } : {}), outputConfig: { effort: native } }
  return { reasoningEffort: native, ...(control.toggleParameter ? {thinkingSwitch:{parameter:control.toggleParameter,enabled:true}} : {}) }
}
