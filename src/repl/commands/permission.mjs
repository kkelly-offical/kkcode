/**
 * 权限与工作区信任命令。
 *
 * `/permission` 是全部命令里分支最多的一条（十个子命令），因为它同时管三件事：
 * 看当前档位与规则、切档、以及把档位落盘。三件事挤在一条命令里是刻意的 ——
 * 用户脑子里它们是同一个话题。
 *
 * `/trust` 与 `/untrust` 的两段初始化几乎对称，只有最后传给 `setTrusted` 的
 * 布尔值与提示文案不同，所以共用一个 `reinitializeExtensions`：信任状态改变后
 * 必须重建工具、技能、子智能体、钩子与自定义命令五套注册表，漏一套就会出现
 * 「已经 /trust 了但项目工具还是被拦」这类不一致。
 */

import { PermissionEngine } from "../../permission/engine.mjs"
import { persistTrust, revokeTrust } from "../../permission/workspace-trust.mjs"
import { normalizePermissionLevel } from "../../permission/rules.mjs"
import {
  listLearnedRules,
  removeLearnedRules,
  isLearnedRule,
  describeRule
} from "../../permission/learned-rules.mjs"
import { applyWorkspaceTrustPolicy, resolveExtensionPolicy } from "../../context.mjs"
import { ToolRegistry } from "../../tool/registry.mjs"
import { SkillRegistry } from "../../skill/registry.mjs"
import { initHookBus } from "../../plugin/hook-bus.mjs"
import { loadCustomCommands } from "../../command/custom-commands.mjs"
import { escapeTerminalText } from "../../provider/model-id.mjs"
import { approvalFromLegacy } from "../../core/modes.mjs"
import { applyPermissionLevel, nextPermissionLevel } from "../permission-flow.mjs"
import {
  pickConfigPathForScope,
  readConfigFile,
  writeConfigFile,
  persistPermissionConfig
} from "../config-persistence.mjs"

/**
 * 信任状态变了 → 五套注册表全部重建。
 *
 * 顺序无关，但**数量**有关：少重建一套就会留下一个仍按旧信任状态工作的子系统。
 */
async function reinitializeExtensions(ctx, setCustomCommands) {
  const extensionPolicy = resolveExtensionPolicy(ctx.configState)
  await ToolRegistry.initialize({
    config: extensionPolicy.config,
    cwd: process.cwd(),
    force: true,
    allowProjectSources: extensionPolicy.allowProjectSources
  })
  await SkillRegistry.initialize(extensionPolicy.config, process.cwd(), {
    allowProjectSources: extensionPolicy.allowProjectSources
  })
  const { CustomAgentRegistry } = await import("../../agent/custom-agent-loader.mjs")
  await CustomAgentRegistry.initialize(process.cwd(), {
    allowProjectSources: extensionPolicy.allowProjectSources
  })
  await initHookBus(process.cwd(), extensionPolicy.config, {
    allowProjectSources: extensionPolicy.allowProjectSources,
    force: true
  })
  setCustomCommands(await loadCustomCommands(process.cwd(), {
    allowProjectSources: extensionPolicy.allowProjectSources
  }))
}

export const permissionCommands = [
  {
    names: ["trust"],
    desc: "trust this workspace",
    argMode: "none",
    run: async ({ print, ctx, setCustomCommands }) => {
      await persistTrust(process.cwd())
      ctx.trustState = { trusted: true }
      applyWorkspaceTrustPolicy(ctx.configState, ctx.trustState, process.cwd())
      await reinitializeExtensions(ctx, setCustomCommands)
      PermissionEngine.setTrusted(true)
      print("workspace trusted", { channel: "notice", topic: "command" })
      return { exit: false }
    }
  },

  {
    names: ["untrust"],
    desc: "revoke workspace trust",
    argMode: "none",
    run: async ({ print, ctx, setCustomCommands }) => {
      await revokeTrust(process.cwd())
      ctx.trustState = { trusted: false }
      applyWorkspaceTrustPolicy(ctx.configState, ctx.trustState, process.cwd())
      await reinitializeExtensions(ctx, setCustomCommands)
      PermissionEngine.setTrusted(false)
      print("workspace trust revoked — project tools and extensions are now blocked", { channel: "notice", topic: "command" })
      return { exit: false }
    }
  },

  {
    names: ["permission"],
    desc: "permission policy / cache",
    argMode: "optional",
    run: async ({ args, print, showInfo, state, ctx }) => {
      const tokens = args ? args.split(/\s+/) : []
      const sub = (tokens[0] || "show").toLowerCase()
      const permission = ctx.configState.config.permission || (ctx.configState.config.permission = {})

      if (sub === "show") {
        // 档位、非交互默认值、以及当前生效的规则一起给全 —— 此前只打两行档位，
        // 想看规则还要另外记得 /permission list。
        const all = Array.isArray(permission.rules) ? permission.rules : []
        const learned = listLearnedRules(all)
        const manual = all.filter((rule) => !isLearnedRule(rule))
        const lines = [
          `level:    ${normalizePermissionLevel(permission)}`,
          `non_tty:  ${permission.non_tty_default || "deny"}`,
          ""
        ]
        if (manual.length) {
          lines.push(`configured rules (${manual.length}):`)
          for (const rule of manual) lines.push(`  ${escapeTerminalText(describeRule(rule))}`)
          lines.push("")
        }
        if (learned.length) {
          lines.push(`always-allow rules (${learned.length}) — /permission forget <n>:`)
          for (const [index, rule] of learned.entries()) {
            lines.push(`  [${index}] ${escapeTerminalText(describeRule(rule))}`)
          }
          lines.push("")
        }
        if (!all.length) lines.push("no permission rules configured", "")
        lines.push("  /permission <readonly|manual|accept-edits|yolo> 切档 · /permission save 落盘")
        showInfo("permission", lines.join("\n"), { maxRows: 18 })
        return { exit: false, openPolicyPicker: true }
      }

      if (sub === "cycle") {
        // Shift+Tab 在 0.4.0 改切模式，审批档单独用这条命令循环
        const next = nextPermissionLevel(permission)
        ctx.configState.config.permission = applyPermissionLevel(next, permission)
        print(`permission.level -> ${next} (runtime)`, { channel: "notice", topic: "permission" })
        return { exit: false }
      }

      if (sub === "list" || sub === "rules") {
        const all = Array.isArray(permission.rules) ? permission.rules : []
        const learned = listLearnedRules(all)
        const manual = all.filter((rule) => !isLearnedRule(rule))
        if (!all.length) {
          print("no permission rules configured", { channel: "notice", topic: "permission" })
          return { exit: false }
        }
        const lines = []
        if (manual.length) {
          lines.push(`configured rules (${manual.length}):`)
          for (const rule of manual) lines.push(`  ${escapeTerminalText(describeRule(rule))}`)
          if (learned.length) lines.push("")
        }
        if (learned.length) {
          lines.push(`always-allow rules (${learned.length}) — /permission forget <n>:`)
          for (const [index, rule] of learned.entries()) {
            lines.push(`  [${index}] ${escapeTerminalText(describeRule(rule))}`)
          }
        }
        showInfo(`permission rules (${all.length})`, lines.join("\n"), { maxRows: 18 })
        return { exit: false }
      }

      if (sub === "forget") {
        const arg = String(tokens[1] || "").toLowerCase()
        const all = arg === "--learned" || arg === "all"
        if (!all && !/^\d+$/.test(arg)) {
          print("usage: /permission forget <n|all>", { channel: "notice", topic: "command", tone: "error" })
          return { exit: false }
        }
        const outcome = removeLearnedRules(permission.rules, all ? { all: true } : { index: Number(arg) })
        if (!outcome.removed.length) {
          print("no matching always-allow rule", { channel: "notice", topic: "command", tone: "error" })
          return { exit: false }
        }
        permission.rules = outcome.rules
        try {
          const target = pickConfigPathForScope("user", ctx.configState?.source, process.cwd())
          const existing = await readConfigFile(target)
          const persisted = removeLearnedRules(existing?.permission?.rules, all ? { all: true } : { index: Number(arg) })
          await writeConfigFile(target, {
            ...existing,
            permission: { ...(existing.permission || {}), rules: persisted.rules }
          })
          print(`forgot ${outcome.removed.length} always-allow rule(s) -> ${target}`, { channel: "notice", topic: "permission" })
        } catch (error) {
          print(`forgot ${outcome.removed.length} rule(s) in this session, but saving failed: ${escapeTerminalText(error.message)}`)
        }
        return { exit: false }
      }

      if (approvalFromLegacy(sub)) {
        const applied = applyPermissionLevel(sub, permission)
        ctx.configState.config.permission = applied
        print(applied.level === sub
          ? `permission.level -> ${applied.level} (runtime)`
          : `permission.level -> ${applied.level} (runtime, ${sub} 已合并为 ${applied.level})`,
          { channel: "notice", topic: "permission" })
        return { exit: false }
      }

      if (["ask", "allow", "deny"].includes(sub)) {
        // 0.3.x 这里只写 mode/default_policy，而判定链只看 level，实际是静默 no-op。
        const mapped = sub === "allow" ? "accept-edits" : sub === "deny" ? "readonly" : "manual"
        ctx.configState.config.permission = applyPermissionLevel(mapped, permission)
        print(`/permission ${sub} 已弃用，已映射为 permission.level -> ${mapped} (runtime)`)
        return { exit: false }
      }

      if (sub === "non-tty") {
        const value = String(tokens[1] || "").toLowerCase()
        if (!["allow_once", "deny"].includes(value)) {
          print("usage: /permission non-tty <allow_once|deny>", { channel: "notice", topic: "command", tone: "error" })
          return { exit: false }
        }
        permission.non_tty_default = value
        print(`permission.non_tty_default -> ${value} (runtime)`, { channel: "notice", topic: "permission" })
        return { exit: false }
      }

      if (sub === "save") {
        const scope = String(tokens[1] || "project").toLowerCase()
        if (!["project", "user"].includes(scope)) {
          print("usage: /permission save [project|user]", { channel: "notice", topic: "command", tone: "error" })
          return { exit: false }
        }
        try {
          const target = await persistPermissionConfig({
            scope,
            ctx,
            values: {
              level: normalizePermissionLevel(permission),
              non_tty_default: permission.non_tty_default || "deny"
            }
          })
          print(`permission saved (${scope}) -> ${target}`, { channel: "notice", topic: "command" })
        } catch (error) {
          print(`permission save failed: ${error.message}`, { channel: "notice", topic: "command", tone: "error" })
        }
        return { exit: false }
      }

      if (sub === "session-clear" || sub === "reset") {
        PermissionEngine.clearSession(state.sessionId)
        print(`permission session cache cleared: ${state.sessionId}`, { channel: "notice", topic: "command" })
        return { exit: false }
      }

      // 兜底 usage：0.6.14 把「对被拒命令的反馈」改成瞬时提示时漏了这一条，
      // 因为那轮用的是手写清单。枚举驱动的测试（overlay-panel）抓到了它。
      print("usage: /permission [show|readonly|review|auto|edit|full-auto|yolo|non-tty <allow_once|deny>|save [project|user]|session-clear]",
        { channel: "notice", topic: "command", tone: "error" })
      return { exit: false }
    }
  }
]
