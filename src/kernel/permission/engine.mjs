import { PermissionError } from "../core/errors.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { defaultEventBus } from "../core/events.mjs"
import { deprecatedSingletonAlias } from "../core/deprecations.mjs"
import { evaluatePermission } from "./rules.mjs"
import { defaultPermissionPromptChannel } from "./prompt.mjs"
import { safeAppendAuditEntry } from "../../storage/audit-store.mjs"
import { sanitizeAuditMetadata, summarizeAuditContent } from "../../audit/event.mjs"

function cacheKey(tool, pattern) {
  return `${tool}::${pattern || "*"}`
}

async function auditPermission(type, context, payload) {
  const safePayload = {
    ...payload,
    ...(Object.prototype.hasOwnProperty.call(payload, "args")
      ? { args: summarizeAuditContent(payload.args) }
      : {}),
    ...(payload.command ? { command: summarizeAuditContent(payload.command) } : {}),
    ...(payload.reason ? { reason: summarizeAuditContent(payload.reason) } : {}),
    ...(context.tool === "bash" && payload.pattern
      ? { pattern: summarizeAuditContent(payload.pattern) }
      : {})
  }
  await safeAppendAuditEntry({
    type,
    sessionId: context.sessionId,
    turnId: context.turnId || null,
    traceId: context.traceId || null,
    requestId: context.requestId || null,
    reviewId: context.reviewId || null,
    tool: context.tool,
    ...sanitizeAuditMetadata(safePayload)
  })
}

/**
 * 拒绝消息。带上判定来源与理由 —— 「为什么被拒」决定了模型下一步该做什么：
 * 档位不够可以请用户升档，撞了保护清单则应当换目标或请用户手动处理。
 */
function denialMessage(tool, decision) {
  const parts = [`permission denied for tool ${tool}`]
  if (decision?.source) parts.push(`(${decision.source})`)
  const detail = decision?.reason || (decision?.protectedPath ? `${decision.protectedPath} is protected` : "")
  return detail ? `${parts.join(" ")}: ${detail}` : parts.join(" ")
}

/**
 * PermissionEngine 工厂（1.0.0 阶段 2a）：sessionAllow / workspaceTrusted /
 * persistGrantHandler 收编为实例字段（M3 §四.2），每个 kernel 实例一份。
 *
 * @param {object} [deps]
 * @param {object} [deps.promptChannel] 审批提示通道（默认进程级通道，见 prompt.mjs）
 * @param {object} [deps.eventBus] 事件总线（默认进程级默认总线，见 core/events.mjs）
 */
export function createPermissionEngine({ promptChannel = defaultPermissionPromptChannel, eventBus = defaultEventBus } = {}) {
  const sessionAllow = new Map()
  let workspaceTrusted = false
  let persistGrantHandler = null

  return {
    setTrusted(value) { workspaceTrusted = Boolean(value) },
    isTrusted() { return workspaceTrusted },
    /**
     * 注册「Always Allow」的落盘回调。引擎自身不做 IO，宿主（REPL / CLI）
     * 决定规则写到哪个配置文件，测试可注入假实现。
     */
    setPersistGrantHandler(handler) {
      persistGrantHandler = typeof handler === "function" ? handler : null
    },
    clearSession(sessionId) {
      sessionAllow.delete(sessionId)
    },
    listSession(sessionId) {
      return [...(sessionAllow.get(sessionId) || new Set())]
    },
    async check({
      config,
      sessionId,
      turnId = "",
      traceId = "",
      requestId = "",
      reviewId = "",
      tool,
      mode,
      pattern = "*",
      command = "",
      args = {},
      risk = 0,
      reason = "",
      workspace = "",
      // 工具自报的能力，优先于静态分类表。风险取决于参数的工具需要它 ——
      // 例如技能：模板展开是纯提示词，可编程技能会执行任意 JS。
      capability = null
    }) {
      if (!workspaceTrusted) throw new PermissionError("workspace not trusted — run /trust to enable tools")
      const auditContext = { sessionId, turnId, traceId, requestId, reviewId, tool }
      const key = cacheKey(tool, pattern)
      const set = sessionAllow.get(sessionId)
      if (set?.has(key)) {
        await eventBus.emit({
          type: EVENT_TYPES.PERMISSION_DECIDED,
          sessionId,
          payload: { tool, decision: "allow_session", source: "cache" }
        })
        await auditPermission("permission.decided", auditContext, {
          decision: "allow_session", source: "cache", mode, pattern, risk
        })
        return { decision: "allow_session", granted: true }
      }

      const decision = evaluatePermission({ config, tool, mode, pattern, command, risk, workspace, capability })
      if (decision.action === "allow") {
        await eventBus.emit({
          type: EVENT_TYPES.PERMISSION_DECIDED,
          sessionId,
          payload: { tool, decision: "allow_once", source: decision.source }
        })
        await auditPermission("permission.decided", auditContext, {
          decision: "allow_once", source: decision.source, mode, pattern, risk
        })
        return { decision: "allow_once", granted: true }
      }
      if (decision.action === "deny") {
        await eventBus.emit({
          type: EVENT_TYPES.PERMISSION_DECIDED,
          sessionId,
          payload: { tool, decision: "deny", source: decision.source }
        })
        await auditPermission("permission.decided", auditContext, {
          decision: "deny", source: decision.source, mode, pattern, risk
        })
        // decision.reason 必须带出去。保护路径这类拒绝的价值全在理由里 ——
        // 只说「permission denied for tool write」的话，模型既不知道自己撞的是
        // 保护清单（而非档位不够），也无法向用户解释或换个可行的做法。
        throw new PermissionError(denialMessage(tool, decision))
      }

      // 策略层给出的理由（保护路径等）要并进提示：它解释的是「为什么这一次
      // 需要确认」，而调用方传的 reason 说的是「这次调用要做什么」。缺了前者，
      // 无 TTY 场景下拒绝消息就只剩一句空洞的 permission denied。
      const askReason = [reason, decision.reason].filter(Boolean).join(" — ")
      await eventBus.emit({
        type: EVENT_TYPES.PERMISSION_ASKED,
        sessionId,
        payload: { tool, mode, pattern, command, args, reason: askReason, risk, source: decision.source }
      })
      await auditPermission("permission.asked", auditContext, {
        mode, pattern, command, args, reason: askReason, risk
      })
      const reply = await promptChannel.askPermissionInteractive({
        tool,
        sessionId,
        pattern,
        command,
        args,
        risk,
        reason: askReason,
        defaultAction: config.permission?.non_tty_default || "deny"
      })
      if (reply === "allow_session" || reply === "allow_always") {
        const next = sessionAllow.get(sessionId) || new Set()
        next.add(key)
        sessionAllow.set(sessionId, next)

        let persisted = false
        if (reply === "allow_always" && persistGrantHandler) {
          try {
            persisted = Boolean(await persistGrantHandler({ tool, pattern, command, workspace }))
          } catch (err) {
            // 落盘失败不应中断本次调用：会话内授权已经生效
            console.error("[permission] persist grant failed:", err?.message || err)
          }
        }

        const outcome = reply === "allow_always" ? "allow_always" : "allow_session"
        await eventBus.emit({
          type: EVENT_TYPES.PERMISSION_DECIDED,
          sessionId,
          payload: { tool, decision: outcome, source: "interactive", persisted }
        })
        await auditPermission("permission.decided", auditContext, {
          decision: outcome, source: "interactive", mode, pattern, risk, persisted
        })
        return { decision: outcome, granted: true, persisted }
      }
      if (reply === "allow_once") {
        await eventBus.emit({
          type: EVENT_TYPES.PERMISSION_DECIDED,
          sessionId,
          payload: { tool, decision: "allow_once", source: "interactive" }
        })
        await auditPermission("permission.decided", auditContext, {
          decision: "allow_once", source: "interactive", mode, pattern, risk
        })
        return { decision: "allow_once", granted: true }
      }

      await eventBus.emit({
        type: EVENT_TYPES.PERMISSION_DECIDED,
        sessionId,
        payload: { tool, decision: "deny", source: "interactive" }
      })
      await auditPermission("permission.decided", auditContext, {
        decision: "deny", source: "interactive", mode, pattern, risk
      })
      // 非交互环境（kkcode chat、CI、管道输入）里没有人可以「declined」——
      // 拒绝来自 permission.non_tty_default。照抄交互文案会让人去找一个
      // 根本不存在的审批弹窗。阶段 3b 起「问不到人」的判据只剩宿主有没有
      // 注入审批 handler —— 内核自身不在终端上提问。
      const interactive = promptChannel.canAskInteractively()
      throw new PermissionError(
        decision.reason
          ? `permission denied for tool ${tool} (${decision.source}): ${decision.reason}`
          : interactive
            ? `permission denied for tool ${tool} (you declined it)`
            : `permission denied for tool ${tool}: no approval handler injected by the host (kernel never prompts on the TTY itself), and permission.non_tty_default is "${config.permission?.non_tty_default || "deny"}". Raise the approval level (e.g. --yolo), run via a host with an approval UI, or set permission.non_tty_default: allow_once.`
      )
    }
  }
}

// 进程级默认引擎。2b 过渡期 executeTurn 路径（engine→loop→executor）仍读它
// （src/kernel/kernel.mjs 头注），frontends 经 facade 白名单取用它做
// setPersistGrantHandler / clearSession / check 等进程级操作；kernel 实例的
// permissions 命名空间是每实例字段，两者在 2b 期间并存。
export const defaultPermissionEngine = createPermissionEngine()

/**
 * 兼容别名（deprecated）：进程级默认引擎实例。旧 import 路径继续工作，
 * 每次方法调用经 deprecations.mjs 记录；新代码用 createKernel() 句柄的
 * `permissions` 命名空间。
 */
export const PermissionEngine = deprecatedSingletonAlias(
  "kernel.singleton.permission-engine",
  "模块级单例 `PermissionEngine` 已收编为 kernel 实例字段：新代码改用 createKernel() 句柄的 `permissions` 命名空间",
  defaultPermissionEngine
)
