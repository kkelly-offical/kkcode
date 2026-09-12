/**
 * src/cli/tty-prompts.mjs —— TTY 入口的前端审批/提问 handler（1.0.0 阶段 4，
 * M12 遗留补位）。
 *
 * 阶段 3b 删掉内核 fallback readline 之后，内核遇到审批/提问且宿主没注入
 * handler 时只会确定性收口（deny / 空答案）——「内核不碰 TTY」是对的，但
 * 交互式入口（kkcode chat、session resume/retry、ultra start/resume）得有人
 * 把 handler 注入进去，否则交互式 chat 的审批/提问能力整体缺失。本模块就是
 * frontends 侧的注入实现：行式 readline 提问（这些入口没有 REPL 的 TUI
 * 浮层），经 createKernel({ handlers }) 安装；2b 桥会同步进进程级默认通道，
 * executeTurn 路径随即问得到人。
 *
 * 非 TTY（管道、CI）返回 null —— 维持 3b 的确定性收口，绝不在 stdin 上阻塞。
 * 提示写到哪个流由调用方决定：结构化输出（--output-format json 等）的入口应
 * 传 stderr，stdout 契约不能被审批提示污染。
 */

import { createInterface } from "node:readline/promises"

/**
 * @param {object} [options]
 * @param {NodeJS.ReadableStream & { isTTY?: boolean }} [options.input]
 * @param {NodeJS.WritableStream & { isTTY?: boolean }} [options.output]
 * @param {boolean} [options.isTTY] 显式覆盖 TTY 判定（测试用假流时传 true）
 * @returns {{ onPermissionPrompt: Function, onQuestionPrompt: Function } | null}
 *   非 TTY 返回 null（调用方省略 handlers，内核保持确定性收口）。
 */
export function createTtyPromptHandlers({
  input = process.stdin,
  output = process.stdout,
  isTTY = Boolean(input.isTTY && output.isTTY)
} = {}) {
  if (!isTTY) return null

  async function onPermissionPrompt({
    tool,
    sessionId,
    reason = "",
    pattern = "*",
    command = "",
    risk = 0,
    defaultAction = "deny"
  } = {}) {
    const rl = createInterface({ input, output })
    try {
      output.write("\n")
      output.write(`Permission requested for tool: ${tool}\n`)
      output.write(`session: ${sessionId}\n`)
      if (command) output.write(`command: ${command}\n`)
      else if (pattern && pattern !== "*") output.write(`target: ${pattern}\n`)
      if (risk) output.write(`risk: ${risk}/10\n`)
      if (reason) output.write(`reason: ${reason}\n`)
      output.write("Choices: [1] allow once  [2] allow session  [3] always allow  [4] deny\n")
      const answer = (await rl.question("> ")).trim().toLowerCase()
      if (["1", "allow", "allow_once", "once", "y", "yes"].includes(answer)) return "allow_once"
      if (["2", "session", "allow_session"].includes(answer)) return "allow_session"
      if (["3", "always", "allow_always"].includes(answer)) return "allow_always"
      // 空输入与无法识别的输入一律 deny（与 3b 删掉的内核 fallback 同语义）：
      // 猜错方向的代价不对称；non_tty_default 只服务「根本问不到人」的场景。
      return "deny"
    } catch {
      // stdin 中途被关（Ctrl+D、宿主退出）：问不到人 = deny，不阻塞不悬挂
      return "deny"
    } finally {
      rl.close()
    }
  }

  async function onQuestionPrompt({ questions } = {}) {
    if (!Array.isArray(questions) || questions.length === 0) return {}
    const rl = createInterface({ input, output, terminal: input.isTTY === true })
    try {
      return await askQuestionsWithReadline(rl, questions, output)
    } catch {
      // 与内核无 handler 时的确定性收口同形：空答案绝不能被当成用户的选择
      return Object.fromEntries(questions.map((q) => [q.id, ""]))
    } finally {
      rl.close()
    }
  }

  return { onPermissionPrompt, onQuestionPrompt }
}

/**
 * 逐题问答。支持选项编号（含 Custom 自由文本）、`default`（直接回车采用
 * 默认值）与 `secret`（回显成 `•`，真值仍是收到的那串），语义与 REPL 的
 * 浮层表单一致。3b 之前这份实现住在内核里（tool/question-prompt.mjs 的
 * fallback），现归 frontends。
 */
async function askQuestionsWithReadline(rl, questions, out) {
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
