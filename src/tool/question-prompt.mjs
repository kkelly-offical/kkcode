import { stdin as input, stdout as output } from "node:process"
import { createInterface } from "node:readline/promises"

let customPromptHandler = null

export function setQuestionPromptHandler(handler) {
  customPromptHandler = typeof handler === "function" ? handler : null
}

/**
 * 当前是否有 TUI 注册的提问处理器。
 *
 * 必须在**要提问的那一刻**调用，不能在启动时缓存结果 —— REPL 在退出流程里
 * 会 setQuestionPromptHandler(null)，缓存下来的判断会恰好在最需要它的时候
 * 是错的。调用方据此判断「现在问得出结果吗」，问不出就必须显式收口，
 * 不能把空答案当成用户的选择。
 */
export function hasPromptHandler() {
  return customPromptHandler !== null
}

/**
 * 无浮层可用时的逐题问答。
 *
 * 收一个**外部的** readline —— REPL 行模式必须复用它自己那一个：在同一个 stdin
 * 上再开一个 interface，两个都会去消费同一份数据流，答案会被随机分给其中一个。
 *
 * 支持 `secret`（回显成 `•`，真值仍然是 rl 收到的那串）与 `default`（直接回车
 * 采用默认值），与浮层表单的语义保持一致。
 */
export async function askQuestionsWithReadline(rl, questions, out = output) {
  const answers = {}
  for (const q of questions) {
    out.write("\n")
    out.write(`  ${q.text}\n`)
    if (q.description) {
      for (const line of String(q.description).split("\n")) out.write(`  ${line}\n`)
    }
    const options = Array.isArray(q.options) ? q.options : []
    if (options.length) {
      for (let i = 0; i < options.length; i++) {
        const opt = options[i]
        out.write(`    ${i + 1}. ${opt.label}\n`)
        if (opt.description) out.write(`       ${opt.description}\n`)
      }
      if (q.allowCustom !== false) out.write(`    ${options.length + 1}. Custom...\n`)
    } else if (q.default) {
      // secret 的默认值不回显 —— 表单里也没有默认密钥这回事
      out.write(q.secret ? "  （直接回车沿用当前值）\n" : `  [${q.default}]\n`)
    }
    out.write("  > ")
    const raw = (await questionWithEcho(rl, q.secret === true, out)).trim()
    if (options.length) {
      const idx = parseInt(raw, 10)
      answers[q.id] = (idx >= 1 && idx <= options.length)
        ? (options[idx - 1].value || options[idx - 1].label)
        : raw
    } else {
      answers[q.id] = raw || (typeof q.default === "string" ? q.default : "")
    }
  }
  return answers
}

/**
 * 遮蔽回显：readline 把每个按键都写回 output，密钥会原样留在滚屏与录屏里。
 * 换掉 `_writeToOutput` 是标准做法；提示语在此之前已经自己写出去了，所以这里
 * 只会碰到用户敲进去的字符。失败就退回明文，不要因为遮蔽不了而问不出来。
 */
async function questionWithEcho(rl, secret, out) {
  if (!secret || typeof rl._writeToOutput !== "function") return rl.question("")
  const original = rl._writeToOutput
  rl._writeToOutput = (chunk) => {
    const text = String(chunk ?? "")
    if (text.includes("\n") || text.includes("\r")) original.call(rl, "\n")
    else original.call(rl, "•")
  }
  try {
    return await rl.question("")
  } catch {
    return ""
  } finally {
    rl._writeToOutput = original
    out.write("\n")
  }
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
  try {
    return await askQuestionsWithReadline(rl, questions)
  } finally {
    rl.close()
  }
}

/**
 * 计划做完之后的去向。**顺序即编号** —— 下面解析答案时的数字回落由这个数组
 * 派生，不再手写一条 `answer === "5"` 的阶梯。手写的那份在插入一个选项时会
 * 静默错位：数字还在，指向的却是隔壁那一项。
 *
 * Yolo Build 与其余几项的区别不在执行方式，而在**审批边界**：它把审批档降到
 * yolo，工具调用不再逐个确认。因此它的描述必须把代价写在脸上。
 */
const PLAN_ACTIONS = Object.freeze([
  { label: "Build", value: "assistant", description: "Switch to Agent and implement this plan" },
  { label: "Ultra Build", value: "longagent", description: "Switch to Ultra for staged multi-file delivery" },
  { label: "Compact + Build", value: "compact_assistant", description: "Compact context first, then build in Agent" },
  { label: "Compact + Ultra Build", value: "compact_longagent", description: "Compact context first, then build in Ultra" },
  { label: "Yolo Build", value: "yolo", description: "Switch to YOLO and build unattended — approvals off, no per-tool confirmation" },
  { label: "Revise Plan", value: "revise", description: "Continue editing the plan with your feedback" }
])

export async function askPlanApproval({ plan, files = [], planPath = "" }) {
  // 非交互场景下没有人能回答这个问题。0.3.x 会拿到空答案，把它当成
  // 「要求修改但没给理由」，模型于是反复重写计划，直到步数耗尽——一次
  // `kkcode chat --mode plan` 能落下五六个计划文件。这里直接收口。
  if (!customPromptHandler && (!process.stdout.isTTY || !process.stdin.isTTY)) {
    return {
      approved: true,
      requestChanges: false,
      action: "plan_saved",
      feedback: "",
      planPath
    }
  }

  const fileList = files.length ? `\nFiles to modify:\n${files.map(f => `  - ${f}`).join("\n")}` : ""
  const pathText = planPath ? `Plan file: ${planPath}\n\n` : ""
  const questions = [
    {
      id: "plan_approval",
      text: `Plan Next Step`,
      description: `${pathText}${plan}${fileList}`,
      options: PLAN_ACTIONS.map((action) => ({ ...action })),
      multi: false,
      allowCustom: true
    }
  ]
  const answers = await askQuestionInteractive({ questions })
  const answer = String(answers.plan_approval || "").trim().toLowerCase()
  // 纯数字才当编号。`parseInt` 会把「3 个阶段都要」读成 3，而那是一句自由文本，
  // 应当落到下面的「按修改意见处理」。
  const index = /^\d+$/.test(answer) ? Number.parseInt(answer, 10) : 0
  const chosen = PLAN_ACTIONS.find((action) => action.value === answer)
    || (index >= 1 && index <= PLAN_ACTIONS.length ? PLAN_ACTIONS[index - 1] : null)
  if (chosen && chosen.value !== "revise") {
    return { approved: true, requestChanges: false, action: chosen.value, feedback: "", planPath }
  }
  if (chosen?.value === "revise") {
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
