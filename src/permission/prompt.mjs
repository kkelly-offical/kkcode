import { noteDeprecation } from "../kernel/core/deprecations.mjs"

/**
 * 审批提示通道工厂（1.0.0 阶段 2a）：customPromptHandler 槽位收编为实例字段
 * （M3 §四.2）。每个 kernel 实例一个通道，由 createKernel 的
 * handlers.onPermissionPrompt 注入；不再依赖模块级全局槽位。
 *
 * 阶段 3b（M3 耦合点 15）：内核不再自开终端行读取。没有宿主 handler 时
 * 审批不会阻塞在 stdin 上，而是确定性收口：判定落到 defaultAction
 * （来自 permission.non_tty_default，默认 deny）。
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
     * 唯一的提问途径是宿主注册的 customPromptHandler（TUI 浮层 / 宿主自己的
     * 交互实现）。内核不碰 TTY：没注册就是问不到人（`kkcode chat`、CI、
     * 管道输入），判定落到 permission.non_tty_default。
     */
    canAskInteractively() {
      return Boolean(customPromptHandler)
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

      // headless 宿主未注入 handler：确定性收口，绝不阻塞读 stdin。
      if (defaultAction === "allow" || defaultAction === "allow_once") return "allow_once"
      return "deny"
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
