import { stdin as input, stdout as output } from "node:process"
import { createInterface } from "node:readline/promises"
import { noteDeprecation } from "../core/deprecations.mjs"

/**
 * 审批提示通道工厂（1.0.0 阶段 2a）：customPromptHandler 槽位收编为实例字段
 * （M3 §四.2）。每个 kernel 实例一个通道，由 createKernel 的
 * handlers.onPermissionPrompt 注入；不再依赖模块级全局槽位。
 */
export function createPermissionPromptChannel() {
  let customPromptHandler = null

  return {
    setPermissionPromptHandler(handler) {
      customPromptHandler = typeof handler === "function" ? handler : null
    },
    /** 当前注册的自定义处理器（没有则为 null）。kernel 组合根做保存/恢复用。 */
    getPermissionPromptHandler() {
      return customPromptHandler
    },
    /**
     * 现在有没有人可以回答审批？
     *
     * TUI 会注册 customPromptHandler；否则要靠 stdin/stdout 都是 TTY。两者都没有时
     * （`kkcode chat`、CI、管道输入）审批不是「被拒绝」，是**根本问不到人**，
     * 判定落到 permission.non_tty_default。
     */
    canAskInteractively() {
      return Boolean(customPromptHandler) || Boolean(process.stdout.isTTY && process.stdin.isTTY)
    },
    async askPermissionInteractive({
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
  }
}

// 进程级默认通道。阶段 2b 期间内核执行路径（PermissionEngine 默认实例）仍
// 经它回答审批；createKernel 会把宿主 handler 同步安装到这里（带保存/恢复），
// 直到 2c/阶段 3 执行路径改为实例注入。
export const defaultPermissionPromptChannel = createPermissionPromptChannel()

const ALIAS_KEY = "kernel.singleton.permission-prompt"
const ALIAS_MESSAGE = "模块级审批提示槽位已收编为 kernel 实例字段：新代码改用 createKernel() 的 handlers.onPermissionPrompt 注入"
const noteAlias = () => noteDeprecation(ALIAS_KEY, ALIAS_MESSAGE, { removal: "1.x" })

/** 兼容别名（deprecated）：旧 import 路径继续工作，调用经 deprecations.mjs 记录。 */
export function setPermissionPromptHandler(handler) {
  noteAlias()
  return defaultPermissionPromptChannel.setPermissionPromptHandler(handler)
}

/** 兼容别名（deprecated）。 */
export function canAskInteractively() {
  noteAlias()
  return defaultPermissionPromptChannel.canAskInteractively()
}

/** 兼容别名（deprecated）。 */
export function askPermissionInteractive(request) {
  noteAlias()
  return defaultPermissionPromptChannel.askPermissionInteractive(request)
}
