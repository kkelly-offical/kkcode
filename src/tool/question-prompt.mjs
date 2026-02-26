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

export async function askPlanApproval({ plan, files = [] }) {
  const fileList = files.length ? `\nFiles to modify:\n${files.map(f => `  - ${f}`).join("\n")}` : ""
  const questions = [
    {
      id: "plan_approval",
      text: `Plan Review`,
      description: `${plan}${fileList}`,
      options: [
        { label: "Approve", value: "approve", description: "Proceed with this plan" },
        { label: "Request Changes", value: "changes", description: "Revise and resubmit with feedback" },
        { label: "Reject", value: "reject", description: "Cancel this plan entirely" }
      ],
      multi: false,
      allowCustom: true
    }
  ]
  const answers = await askQuestionInteractive({ questions })
  const answer = String(answers.plan_approval || "").trim().toLowerCase()
  if (answer === "approve" || answer === "1") {
    return { approved: true, requestChanges: false, feedback: "" }
  }
  if (answer === "changes" || answer === "2") {
    const rl2 = createInterface({ input, output })
    let changeFeedback = ""
    try { changeFeedback = (await rl2.question("  Feedback> ")).trim() } catch {} finally { rl2.close() }
    return { approved: false, requestChanges: true, feedback: changeFeedback }
  }
  if (answer === "reject" || answer === "3") {
    const rl3 = createInterface({ input, output })
    let rejectFeedback = ""
    try { rejectFeedback = (await rl3.question("  Reason> ")).trim() } catch {} finally { rl3.close() }
    return { approved: false, requestChanges: false, feedback: rejectFeedback }
  }
  // Custom text input: treat as "request changes" with the text as feedback
  return { approved: false, requestChanges: true, feedback: answer }
}
