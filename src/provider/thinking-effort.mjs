/**
 * 思考强度分档。
 *
 * 两家协议表达思考预算的方式完全不同：OpenAI 系是 `reasoning_effort` 字符串，
 * Anthropic 是 `budget_tokens` 绝对数（此前硬编码 10000 —— 对 200K 上下文的
 * 模型太少，对小模型又可能超过它的输出上限）。
 *
 * 所以档位在这里表达为**模型自身输出预算的比例**，落到具体协议时再翻译。
 * 换模型不用改数字，配置里写的是意图（"想深一点"）而不是实现细节。
 */

export const THINKING_TIERS = Object.freeze(["off", "low", "medium", "high", "max"])

/** 各档占模型可用输出预算的比例 */
const TIER_RATIO = Object.freeze({
  off: 0,
  low: 0.15,
  medium: 0.35,
  high: 0.60,
  max: 0.85
})

/** OpenAI 系的 reasoning_effort 只有三档，medium 归到 low 与 high 之间 */
const OPENAI_EFFORT = Object.freeze({
  off: "none",
  low: "low",
  medium: "medium",
  high: "high",
  max: "max"
})

/** Anthropic 的 thinking 预算下限：低于这个数扩展思考没有意义 */
const MIN_BUDGET_TOKENS = 1024
/** 兜底的输出预算 —— 只在既拿不到模型能力也没有配置时使用 */
const FALLBACK_MAX_OUTPUT = 16384

export function normalizeThinkingTier(value, fallback = "high") {
  const tier = String(value ?? "").trim().toLowerCase()
  if (THINKING_TIERS.includes(tier)) return tier
  // 0.5.x 用 reasoning_effort 的取值直接当档位，兼容过来
  if (tier === "none") return "off"
  return THINKING_TIERS.includes(fallback) ? fallback : "high"
}

/**
 * 把档位翻译成 provider 能理解的参数。
 *
 * @param {object} p
 * @param {string} p.tier off|low|medium|high|max
 * @param {string} p.protocol "openai" | "anthropic"
 * @param {number} [p.maxOutputTokens] 模型自报的输出上限（目录发现或配置）
 * @param {number} [p.contextLimit] 上下文上限，作为输出上限的推算依据
 * @returns {{reasoningEffort?: string, thinking?: {type: string, budget_tokens: number}}}
 */
export function resolveThinkingParams({
  tier = "high",
  protocol = "openai",
  maxOutputTokens = 0,
  contextLimit = 0
} = {}) {
  const level = normalizeThinkingTier(tier)

  if (protocol === "anthropic") {
    if (level === "off") return {}
    const budget = thinkingBudgetTokens({ tier: level, maxOutputTokens, contextLimit })
    return { thinking: { type: "enabled", budget_tokens: budget } }
  }

  const effort = OPENAI_EFFORT[level]
  return effort && effort !== "none" ? { reasoningEffort: effort } : {}
}

/**
 * 按比例算出思考预算，而不是写死一个数。
 *
 * 输出上限的来源优先级：模型自报 → 上下文的 1/8（多数模型的输出上限大致在
 * 这个量级）→ 兜底常数。算出来后压在 [1024, 输出上限-1024] 区间内 ——
 * 思考预算吃满输出预算会让模型没有余量写正文。
 */
export function thinkingBudgetTokens({ tier = "high", maxOutputTokens = 0, contextLimit = 0 }) {
  const level = normalizeThinkingTier(tier)
  if (level === "off") return 0

  const declared = Number(maxOutputTokens) || 0
  const derived = Number(contextLimit) > 0 ? Math.floor(Number(contextLimit) / 8) : 0
  const budgetBase = declared || derived || FALLBACK_MAX_OUTPUT

  const raw = Math.floor(budgetBase * TIER_RATIO[level])
  const ceiling = Math.max(MIN_BUDGET_TOKENS, budgetBase - MIN_BUDGET_TOKENS)
  return Math.max(MIN_BUDGET_TOKENS, Math.min(raw, ceiling))
}

/**
 * 模型是否支持扩展思考。
 *
 * 目录发现能拿到 `supportedParameters` 时以它为准（OpenRouter 等会报），
 * 否则按已知的模型名族判断 —— 这只是启发式，拿不准时返回 null 表示「不知道」，
 * 让调用方自己决定要不要试。
 */
export function supportsThinking({ modelId = "", supportedParameters = null } = {}) {
  if (Array.isArray(supportedParameters)) {
    return supportedParameters.some((p) => /reasoning|thinking/i.test(String(p)))
  }
  const id = String(modelId).toLowerCase()
  if (!id) return null
  if (/(^|[^a-z])(o[1-4]|gpt-5|claude-(opus|sonnet)-[4-9]|k[2-9]|deepseek-r|qwen3|gemini-[2-9])/.test(id)) return true
  return null
}
