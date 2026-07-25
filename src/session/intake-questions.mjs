import { askQuestionInteractive, hasPromptHandler } from "../tool/question-prompt.mjs"

/**
 * 开工前的需求澄清 —— Ultra 与 plan 模式共用。
 *
 * 为什么新写一个：`planner.intake_questions` 名不副实。它背后的
 * `runIntakeDialogue` 是**模型自问自答** —— 提示词明确要求模型
 * "provide your BEST ASSUMPTION as the answer"，一个问题都不会送到用户面前。
 * 于是「开工前问清楚」这件事在 0.5.x 里从未真正发生过。
 *
 * 收口语义照抄 askBlockedDecision（ultra-interaction.mjs），那是全仓唯一
 * 成熟的交互模板：现场探测能不能提问、空答案绝不当成某个具体选择、
 * 非交互时返回显式的安全默认值并带上 why。
 *
 * 澄清是可选步骤：问不到人就带着模型的假设继续跑，而不是卡住 —— 这与
 * 受阻交互不同（那里必须收口成一个终局动作）。
 */

/** 单次澄清最多问几题 —— 再多就成了盘问，用户会直接跳过。 */
export const MAX_INTAKE_QUESTIONS = 5

/**
 * 需求澄清的五个维度。内容取自 longagent-plan.mjs 的 INTAKE ANALYST 清单
 * （那份清单质量很高，只是从来没拿去问人）。
 */
export const INTAKE_DIMENSIONS = Object.freeze([
  { key: "scope", label: "范围边界", hint: "哪些要做、哪些明确不做" },
  { key: "stack", label: "技术选型", hint: "沿用现有模式还是引入新依赖" },
  { key: "contract", label: "接口契约", hint: "输入输出形状、命名、兼容性要求" },
  { key: "quality", label: "质量约束", hint: "测试、性能、错误处理到什么程度" },
  { key: "order", label: "依赖顺序", hint: "先后次序与可并行的部分" }
])

function normalizeQuestion(raw, index) {
  const text = String(raw?.text || raw?.question || "").trim()
  if (!text) return null
  const options = Array.isArray(raw?.options)
    ? raw.options.map((opt) => (typeof opt === "string"
        ? { label: opt, value: opt }
        : { label: String(opt?.label || opt?.value || ""), value: opt?.value ?? opt?.label, description: opt?.description })).filter((o) => o.label)
    : []
  return {
    id: String(raw?.id || `intake_${index + 1}`),
    header: String(raw?.header || raw?.dimension || "需求澄清").slice(0, 12),
    text,
    description: String(raw?.why || raw?.description || ""),
    options,
    allowCustom: true,
    // 模型给出的兜底假设：用户不答时按它走，并在结果里标注来源
    assumption: String(raw?.assumption || raw?.default || "").trim()
  }
}

function assumedAnswers(questions, why) {
  return {
    asked: false,
    why,
    answers: questions.map((q) => ({
      id: q.id,
      question: q.text,
      answer: q.assumption,
      source: q.assumption ? "assumption" : "unanswered"
    }))
  }
}

/**
 * 向用户提出澄清问题。
 *
 * @param {object} p
 * @param {Array} p.questions 模型生成的问题（每题可带 assumption 兜底）
 * @param {boolean} p.allowQuestion
 * @param {object} p.config
 * @param {object} p.deps 测试注入点
 * @returns {Promise<{asked: boolean, why?: string, answers: Array<{id, question, answer, source}>}>}
 */
export async function askIntakeQuestions({
  questions = [],
  allowQuestion = true,
  config = {},
  deps = {}
} = {}) {
  const askFn = deps.askQuestionInteractive || askQuestionInteractive
  const hasHandler = deps.hasPromptHandler || hasPromptHandler
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY && process.stdin.isTTY)

  const plannerConfig = config?.agent?.longagent?.planner?.intake_questions || {}
  const normalized = questions.map(normalizeQuestion).filter(Boolean)
  const limit = Math.max(1, Math.min(
    Number(plannerConfig.max_questions) || MAX_INTAKE_QUESTIONS,
    MAX_INTAKE_QUESTIONS
  ))
  const asked = normalized.slice(0, limit)

  if (plannerConfig.enabled === false) return assumedAnswers(asked, "disabled_by_config")
  if (!asked.length) return { asked: false, why: "no_questions", answers: [] }
  if (!allowQuestion) return assumedAnswers(asked, "allow_question_false")
  // 必须在提问那一刻判断：REPL 退出流程会把 handler 置空
  if (!hasHandler() && !isTTY) return assumedAnswers(asked, "non_tty")

  let raw
  try {
    raw = await askFn({ questions: asked.map(({ assumption, ...q }) => q) })
  } catch {
    return assumedAnswers(asked, "prompt_failed")
  }

  const answers = asked.map((q) => {
    const value = String(raw?.[q.id] ?? "").trim()
    // 空串与 "(skipped)" 都表示用户没有回答 —— 绝不能当成一个具体答案，
    // 这正是 0.4.1 plan 审批死循环那类事故的根因。
    const skipped = !value || value === "(skipped)"
    return {
      id: q.id,
      question: q.text,
      answer: skipped ? q.assumption : value,
      source: skipped ? (q.assumption ? "assumption" : "unanswered") : "user"
    }
  })

  return { asked: answers.some((a) => a.source === "user"), answers }
}

/**
 * 把澄清结果拼成注入规划提示词的一段文本。
 * 用户回答与模型假设分开标注 —— 规划时应当更信任前者。
 */
export function renderIntakeAnswers(result) {
  const answers = result?.answers || []
  if (!answers.length) return ""
  const lines = ["<requirements-clarified>"]
  for (const item of answers) {
    if (!item.answer) continue
    const tag = item.source === "user" ? "用户确认" : "未确认的假设"
    lines.push(`- ${item.question}\n  [${tag}] ${item.answer}`)
  }
  lines.push("</requirements-clarified>")
  return lines.length > 2 ? lines.join("\n") : ""
}
