import { askQuestionInteractive, hasPromptHandler } from "../tool/question-prompt.mjs"
import { renderBlockedReportText } from "./blocked-report.mjs"

/**
 * Ultra 受阻时向用户求助。
 *
 * 非 TTY 收口是这里的全部意义：askQuestionInteractive 在没有 TUI handler 且
 * 没有 TTY 时返回全空串 —— **空答案绝不能被解读为「继续」**。0.4.1 的 plan
 * 审批死循环、0.4.x 的门禁偏好被写坏，都是同一类事故：把「没人回答」当成了
 * 某个具体的选择。收口语义照抄 askPlanApproval：显式返回一个安全默认值。
 *
 * 非 TTY 默认 deliver_partial：保留已完成的工作、写报告、非零退出码。
 * continue 在无人值守时会烧掉整个预算且无法收敛，必须显式配置才可用；
 * stop 会丢掉「已完成部分」的表达。
 */

export const BLOCKED_ACTIONS = Object.freeze(["continue", "guidance", "deliver_partial", "stop"])

function nonInteractiveFallback(config, why) {
  const configured = config?.agent?.longagent?.ultra?.on_blocked_non_tty
  const action = BLOCKED_ACTIONS.includes(configured) ? configured : "deliver_partial"
  return { action, text: "", source: "non_tty_default", why }
}

/**
 * @returns {{action: "continue"|"guidance"|"deliver_partial"|"stop", text: string, source: string, why?: string}}
 */
export async function askBlockedDecision({ report, allowQuestion = true, config = {}, deps = {} } = {}) {
  const askFn = deps.askQuestionInteractive || askQuestionInteractive
  const hasHandler = deps.hasPromptHandler || hasPromptHandler
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY && process.stdin.isTTY)

  if (!allowQuestion) return nonInteractiveFallback(config, "allow_question_false")
  // 必须在提问那一刻判断 —— REPL 退出流程会把 handler 置空，缓存的判断
  // 恰好会在最需要它的时候是错的。
  if (!hasHandler() && !isTTY) return nonInteractiveFallback(config, "non_tty")

  const summary = report
    ? renderBlockedReportText(report).join("\n").slice(0, 2000)
    : ""

  const answers = await askFn({
    questions: [{
      id: "ultra_blocked",
      header: "Ultra",
      text: "Ultra 目标受阻，如何继续？",
      description: summary,
      options: [
        { label: "继续再试", value: "continue", description: "针对未达成的部分重新规划，再跑一轮" },
        { label: "我来给指引", value: "guidance", description: "输入一条指引，下一轮按它调整方向" },
        { label: "交付已完成部分", value: "deliver_partial", description: "保留已完成的工作，输出受阻报告后结束" },
        { label: "停止", value: "stop", description: "停止并输出受阻报告" }
      ],
      allowCustom: true
    }]
  })

  const raw = String(answers?.ultra_blocked || "").trim()
  // 空答案 = 没人回答（handler 被撤、用户直接回车、超时）。收口，不猜。
  if (!raw || raw === "(skipped)") return nonInteractiveFallback(config, "empty_answer")

  const lower = raw.toLowerCase()
  if (["continue", "1", "继续", "继续再试"].includes(lower)) return { action: "continue", text: "", source: "user" }
  if (["deliver_partial", "3", "交付", "交付已完成部分"].includes(lower)) return { action: "deliver_partial", text: "", source: "user" }
  if (["stop", "4", "停止", "abort", "cancel", "取消", "中止"].includes(lower)) return { action: "stop", text: "", source: "user" }
  if (["guidance", "2", "我来给指引"].includes(lower)) {
    // 选了「给指引」但还没给内容 —— 再要一次；要不到就当没回答
    const followUp = await askFn({
      questions: [{ id: "ultra_guidance", header: "Ultra", text: "你的指引（会进入下一轮的上下文）：", allowCustom: true, options: [] }]
    })
    const text = String(followUp?.ultra_guidance || "").trim()
    return text && text !== "(skipped)"
      ? { action: "guidance", text, source: "user" }
      : nonInteractiveFallback(config, "empty_guidance")
  }
  // 自定义文本一律当指引 —— 这是最有用的默认解释：用户直接打了一句话，
  // 那句话就是他想让下一轮知道的事。
  return { action: "guidance", text: raw, source: "user" }
}

/**
 * TTY 下让用户逐条确认 manual 判据。返回确认通过的判据 id 集合。
 * 非 TTY 返回空集 —— manual 判据保持 pending，绝不代替用户点头。
 */
export async function confirmManualCriteria({ pending, allowQuestion = true, deps = {} } = {}) {
  const askFn = deps.askQuestionInteractive || askQuestionInteractive
  const hasHandler = deps.hasPromptHandler || hasPromptHandler
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY && process.stdin.isTTY)
  const confirmed = new Set()
  if (!allowQuestion || (!hasHandler() && !isTTY) || !pending?.length) return confirmed

  const answers = await askFn({
    questions: pending.slice(0, 6).map((criterion) => ({
      id: criterion.id,
      header: "验收确认",
      text: criterion.question || criterion.text,
      options: [
        { label: "已达成", value: "yes", description: "该判据由我确认通过" },
        { label: "未达成", value: "no", description: "保持未达成状态" }
      ]
    }))
  })
  for (const criterion of pending) {
    if (String(answers?.[criterion.id] || "").toLowerCase() === "yes") confirmed.add(criterion.id)
  }
  return confirmed
}
