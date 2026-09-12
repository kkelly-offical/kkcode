import { modelContextLimit } from "../session/compaction.mjs"

/**
 * 工具输出预算。
 *
 * 0.6.3 之前是一个硬编码常量 `TOOL_RESULT_ACTIVE_LIMIT = 3000` 字符，作用在
 * 所有工具的返回值上。后果：一个 268 行的普通源文件是 12494 字符，模型只能
 * 看到四分之一 —— 而 read 那个 2000 行的上限**从未生效过**，真正的天花板是
 * 它的 1/25。占 1M 上下文模型的比例是 0.67%。
 *
 * 同行的量级（调研自源码/文档）：opencode 50KB 字节帽，Codex shell 输出
 * 1 MiB，Claude Code 25k token（约 100KB）。3000 字符低了一到两个数量级。
 *
 * 预算按**模型自身的上下文**推算而不是写死：换模型不用改数字，配置里写的是
 * 意图（占上下文的多大比例）。
 *
 * 注意这不是「取消上限」。行数上限本身是同行共识、且是有意的行为塑形 ——
 * Anthropic 工程博客的说法是截断要「把 agent 引向更精确的检索」。要改的是
 * 量级，以及让每一次截断都说清还有多少、怎么取。
 */

/** 单次工具结果占上下文的比例。8% 意味着连续十几次调用才逼近压缩阈值。 */
const DEFAULT_RATIO = 0.08

/** 字符/token 的粗略换算：混合中英代码大致 3.5 字符一个 token */
const CHARS_PER_TOKEN = 3.5

/**
 * 下限 16000：比一个中等源文件（约 12500）略宽，保证「读一个普通文件能读全」
 * 这个最基本的期待成立。
 */
const MIN_CHARS = 16000

/**
 * 上限 200000：再大就会让单次调用主导整个上下文，压缩会被频繁触发，
 * 反而降低有效记忆。与 Claude Code 的 25k token 量级相当。
 */
const MAX_CHARS = 200000

/**
 * @param {object} p
 * @param {string} [p.model] 当前模型
 * @param {string} [p.providerType] 当前 provider（不是配置里的默认值）
 * @param {object} [p.config] 完整配置，用于读 provider.model_context 与比例
 * @returns {{chars: number, ratio: number, contextLimit: number}}
 */
export function toolOutputBudget({ model = "", providerType = "", config = null } = {}) {
  const ratio = normalizeRatio(config?.tool?.output_budget_ratio)
  const contextLimit = modelContextLimit(model, config ? { config } : null, providerType)
  const raw = Math.floor(contextLimit * CHARS_PER_TOKEN * ratio)
  return {
    chars: Math.max(MIN_CHARS, Math.min(raw, MAX_CHARS)),
    ratio,
    contextLimit
  }
}

function normalizeRatio(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0 || n > 0.5) return DEFAULT_RATIO
  return n
}

/**
 * 截断提示。
 *
 * 每一处截断都必须回答两件事：**还有多少**，以及**怎么取到**。
 * 0.6.3 之前的提示是中文硬编码且只说了前者 —— 模型知道被截断了，
 * 但不知道下一步该做什么，于是往往就当读完了继续往下走。
 *
 * 措辞抄 opencode，它是同行里唯一每条截断提示都自带下一步参数的。
 *
 * @param {object} p
 * @param {number} p.shown 已展示的量
 * @param {number} p.total 总量
 * @param {string} [p.unit] "chars" | "lines"
 * @param {string} [p.hint] 续读方式，如 `Use read with offset=2001 to continue.`
 */
export function truncationNotice({ shown, total, unit = "chars", hint = "" }) {
  const remaining = Math.max(0, total - shown)
  const base = `[truncated: showing ${shown} of ${total} ${unit}, ${remaining} remaining`
  return hint ? `${base}. ${hint}]` : `${base}]`
}

/** 读取时的「已到文件末尾」提示 —— 与截断提示成对，让两种情况可区分。 */
export function completeNotice({ total, unit = "lines" }) {
  return `[complete: ${total} ${unit}]`
}
