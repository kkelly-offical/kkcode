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
          const desc = opt.description ? ` - ${opt.description}` : ""
          console.log(`    ${i + 1}. ${opt.label}${desc}`)
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
        { label: "Reject", value: "reject", description: "Reject and provide feedback" }
      ],
      multi: false,
      allowCustom: true
    }
  ]
  const answers = await askQuestionInteractive({ questions })
  const answer = String(answers.plan_approval || "").trim().toLowerCase()
  if (answer === "approve" || answer === "1") {
    return { approved: true, feedback: "" }
  }
  const feedback = answer === "reject" || answer === "2" ? "" : answer
  return { approved: false, feedback }
}
