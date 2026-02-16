import { stdin as input, stdout as output } from "node:process"
import { createInterface } from "node:readline/promises"

let customPromptHandler = null

export function setPermissionPromptHandler(handler) {
  customPromptHandler = typeof handler === "function" ? handler : null
}

export async function askPermissionInteractive({ tool, sessionId, reason = "", defaultAction = "deny" }) {
  if (customPromptHandler) {
    const answer = await customPromptHandler({
      tool,
      sessionId,
      reason,
      defaultAction
    })
    if (["allow_once", "allow_session", "deny"].includes(answer)) return answer
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
    if (reason) console.log(`reason: ${reason}`)
    console.log("Choices: [1] allow once  [2] allow session  [3] deny")
    const answer = (await rl.question("> ")).trim().toLowerCase()
    if (["1", "allow", "allow_once", "once", "y", "yes"].includes(answer)) return "allow_once"
    if (["2", "session", "allow_session", "always"].includes(answer)) return "allow_session"
    return "deny"
  } finally {
    rl.close()
  }
}
