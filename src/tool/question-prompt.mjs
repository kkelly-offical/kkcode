import { stdin as input, stdout as output } from "node:process"
import { createInterface } from "node:readline/promises"

let customPromptHandler = null

export function setQuestionPromptHandler(handler) {
  customPromptHandler = typeof handler === "function" ? handler : null
}

export async function askQuestionInteractive({ questions }) {
  if (!Array.isArray(questions) || questions.length === 0) {
    return {}
  }

  // 1. TUI handler (registered by repl.mjs)
  if (customPromptHandler) {
    const answers = await customPromptHandler({ questions })
    if (answers && typeof answers === "object") return answers
  }

  // 2. Non-TTY: return empty answers
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    return Object.fromEntries(questions.map((q) => [q.id, ""]))
  }

  // 3. TTY fallback: readline sequential Q&A
  const rl = createInterface({ input, output })
  const answers = {}
  try {
    for (const q of questions) {
      console.log("")
      console.log(`  ${q.text}`)
      if (q.description) console.log(`  ${q.description}`)
      const options = Array.isArray(q.options) ? q.options : []
      if (options.length) {
        for (let i = 0; i < options.length; i++) {
          const opt = options[i]
          console.log(`    ${i + 1}. ${opt.label}`)
          if (opt.description) console.log(`       ${opt.description}`)
        }
        if (q.allowCustom !== false) {
          console.log(`    ${options.length + 1}. Custom...`)
        }
      }
      const raw = (await rl.question("  > ")).trim()
      if (options.length) {
        const idx = parseInt(raw, 10)
        if (idx >= 1 && idx <= options.length) {
          const chosen = options[idx - 1]
          answers[q.id] = chosen.value || chosen.label
        } else {
          answers[q.id] = raw
        }
      } else {
        answers[q.id] = raw
      }
    }
  } finally {
    rl.close()
  }
  return answers
}

export async function askPlanApproval({ plan, files = [], planPath = "" }) {
  const fileList = files.length ? `\nFiles to modify:\n${files.map(f => `  - ${f}`).join("\n")}` : ""
  const pathText = planPath ? `Plan file: ${planPath}\n\n` : ""
  const questions = [
    {
      id: "plan_approval",
      text: `Plan Next Step`,
      description: `${pathText}${plan}${fileList}`,
      options: [
        { label: "Assistant Build", value: "assistant", description: "Use Assistant to implement this plan" },
        { label: "LongAgent Build", value: "longagent", description: "Use LongAgent for persistent staged delivery" },
        { label: "Compact + Assistant", value: "compact_assistant", description: "Compact context first, then use Assistant" },
        { label: "Compact + LongAgent", value: "compact_longagent", description: "Compact context first, then use LongAgent" },
        { label: "Revise Plan", value: "revise", description: "Continue editing the plan with your feedback" }
      ],
      multi: false,
      allowCustom: true
    }
  ]
  const answers = await askQuestionInteractive({ questions })
  const answer = String(answers.plan_approval || "").trim().toLowerCase()
  if (answer === "assistant" || answer === "1") {
    return { approved: true, requestChanges: false, action: "assistant", feedback: "", planPath }
  }
  if (answer === "longagent" || answer === "2") {
    return { approved: true, requestChanges: false, action: "longagent", feedback: "", planPath }
  }
  if (answer === "compact_assistant" || answer === "3") {
    return { approved: true, requestChanges: false, action: "compact_assistant", feedback: "", planPath }
  }
  if (answer === "compact_longagent" || answer === "4") {
    return { approved: true, requestChanges: false, action: "compact_longagent", feedback: "", planPath }
  }
  if (answer === "revise" || answer === "5") {
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      return { approved: false, requestChanges: true, action: "revise", feedback: "", planPath }
    }
    const rl2 = createInterface({ input, output })
    let changeFeedback = ""
    try { changeFeedback = (await rl2.question("  Revision> ")).trim() } catch {} finally { rl2.close() }
    return { approved: false, requestChanges: true, action: "revise", feedback: changeFeedback, planPath }
  }
  // Custom text input: treat as "request changes" with the text as feedback
  return { approved: false, requestChanges: true, action: "revise", feedback: answer, planPath }
}
