import { ProviderError } from '../core/errors.mjs'

const LABELS = { auto: ['自动', '使用服务端默认设置'], off: ['直答', '关闭思考'], none: ['直答', '关闭思考'],
  minimal: ['微思', '最轻思考'], low: ['略思', '较轻思考'], medium: ['审思', '仔细推敲'], high: ['深思', '深入推演'],
  xhigh: ['精思', '更缜密推演'], max: ['穷理', '更充分推究'], on: ['启思', '开启思考'] }
const RATIOS = { low: .15, medium: .35, high: .6, xhigh: .75, max: .85 }
const fail = message => { throw new ProviderError(message, { reason: 'invalid_thinking_parameter' }) }

/** Public, credential-free UI contract; the same choices drive wire mapping.
 * @param {{model?: string, protocol?: string, metadata?: any, settings?: any, maxTokens?: number}} input */
export function thinkingControl({ model = '', protocol = 'openai', metadata = {}, settings = {}, maxTokens = 0 } = {}) {
  const declared = metadata.reasoning || {}
  const preference = settings.model_options?.[model]?.thinking_effort ?? settings.thinking_effort ?? settings.reasoning_effort ?? 'auto'
  const selected = preference === 'none' ? 'off' : preference
  let levels = declared.levels ? [...declared.levels] : null
  let types = declared.types || []
  let source = declared.supported != null || levels || types.length || declared.toggleParameter ? 'catalog' : 'unknown'
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
  const options = ['auto', ...(canDisable && kind !== 'unsupported' ? ['off'] : []), ...values]
    .map(value => ({ value, label: LABELS[value]?.[0] || value, description: LABELS[value]?.[1] || '模型原生档位', available: true,
      level: ['levels','budget'].includes(kind) && values.every(v => Object.hasOwn(RATIOS,v) || v === 'minimal') && values.includes(value) ? values.indexOf(value)+1 : null }))
  if (!options.some(option => option.value === selected)) options.push({ value: selected, label: `${LABELS[selected]?.[0] || selected} · 待确认`, description: '已保存设置，当前模型未确认支持', available: false, level: null })
  return { kind, source, selected, options, canDisable, nativeOff, types, nativeLevels:declared.nativeLevels || {}, toggleParameter:toggleParameter || null,
    minBudget, budgetUnavailable, budgetCeiling: Number.isFinite(budgetCeiling) ? Math.max(0, budgetCeiling) : 0,
    defaultLevel: declared.defaultLevel || null }
}

/** @param {{control: any, protocol: string, settings?: any, maxTokens: number}} input */
export function mapThinkingRequest({ control, protocol, settings = {}, maxTokens }) {
  const value = control.selected
  const explicit = settings.thinking
  if (explicit?.type) {
    if (protocol !== 'anthropic') fail('当前协议适配器不支持 thinking 对象，请使用自动或该模型支持的思考选项。')
    if (explicit.type === 'enabled') {
      if (!Number.isInteger(explicit.budget_tokens) || explicit.budget_tokens < control.minBudget || explicit.budget_tokens >= maxTokens) fail('思考预算必须处于模型有效范围并小于本次输出额度。')
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
  if (option?.available === false && control.source === 'catalog') fail(`当前模型不支持已选择的思考档位 ${value}，请重新选择或使用自动。`)
  if (control.kind === 'unsupported') fail('当前模型不支持思考参数，请使用自动设置。')
  if (control.toggleParameter && ['off','on'].includes(value)) return { thinkingSwitch:{parameter:control.toggleParameter,enabled:value === 'on'} }
  if (value === 'off') {
    if (!control.canDisable && control.source !== 'unknown') fail('当前模型未声明可关闭思考。')
    return protocol === 'anthropic' ? { thinking: { type: 'disabled' } } : { reasoningEffort: (control.nativeOff ? control.nativeLevels[control.nativeOff] : null) || control.nativeOff || 'none' }
  }
  if (control.kind === 'budget') {
    const ratio = RATIOS[value]
    if (!ratio || control.budgetCeiling < control.minBudget) fail('本次输出额度不足以启用所选思考档位。')
    const budget = Math.max(control.minBudget, Math.min(control.budgetCeiling, Math.floor(maxTokens * ratio)))
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
