import { stdin as input, stdout as output } from "node:process"
import { createInterface } from "node:readline/promises"

let customPromptHandler = null

export function setPermissionPromptHandler(handler) {
  customPromptHandler = typeof handler === "function" ? handler : null
}

/**
 * 现在有没有人可以回答审批？
 *
 * TUI 会注册 customPromptHandler；否则要靠 stdin/stdout 都是 TTY。两者都没有时
 * （`kkcode chat`、CI、管道输入）审批不是「被拒绝」，是**根本问不到人**，
 * 判定落到 permission.non_tty_default。
 */
export function canAskInteractively() {
  return Boolean(customPromptHandler) || Boolean(process.stdout.isTTY && process.stdin.isTTY)
}

export async function askPermissionInteractive({
  tool,
  sessionId,
  reason = "",
  pattern = "*",
  command = "",
  args = {},
  risk = 0,
  defaultAction = "deny"
}) {
  if (customPromptHandler) {
    const answer = await customPromptHandler({
      tool,
      sessionId,
      pattern,
      command,
      args,
      risk,
      reason,
      defaultAction
    })
    if (["allow_once", "allow_session", "allow_always", "deny"].includes(answer)) return answer
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    if (defaultAction === "allow" || defaultAction === "allow_once") return "allow_once"
    return "deny"
  }
  const rl = createInterface({ input, output })
  try {
    console.log("")
    console.log(`Permission requested for tool: ${tool}`)
    console.log(`session: ${sessionId}`)
    if (command) console.log(`command: ${command}`)
    else if (pattern && pattern !== "*") console.log(`target: ${pattern}`)
    if (risk) console.log(`risk: ${risk}/10`)
    if (reason) console.log(`reason: ${reason}`)
    console.log("Choices: [1] allow once  [2] allow session  [3] always allow  [4] deny")
    const answer = (await rl.question("> ")).trim().toLowerCase()
    if (["1", "allow", "allow_once", "once", "y", "yes"].includes(answer)) return "allow_once"
    if (["2", "session", "allow_session"].includes(answer)) return "allow_session"
    if (["3", "always", "allow_always"].includes(answer)) return "allow_always"
    return "deny"
  } finally {
    rl.close()
  }
}
