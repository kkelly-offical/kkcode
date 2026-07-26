/**
 * 模式（航道）命令。
 *
 * 三种形态，此前散在四个相隔很远的 `if` 里：
 *
 *   1. `/mode`            → 开模式选择器
 *   2. `/mode <id>`       → 直接切
 *   3. `/agent` `/plan` …  → 每个航道各有一个直达命令
 *
 * 其中 `/plan`、`/ultra`、`/longagent` 是**双形态**的：裸命令切模式，带参数则
 * 切模式**并把参数包成一段提示词继续跑**。这是唯一一类不终结的命令 —— 它们返回
 * `{ rewrite }` 让路由继续走 prompt 路径。此前这靠在函数中段重新赋值
 * `normalized` 然后依赖后续代码「顺着流下去」，读代码时极难看出来。
 */

import { noteDeprecation } from "../../core/deprecations.mjs"
import { modeIdFromLegacy, MODE_IDS } from "../../core/modes.mjs"
import { formatModeBadge } from "../mode-flow.mjs"
import { escapeTerminalText } from "../../provider/model-id.mjs"

/** 裸命令直达的航道。名字即传给 applyModeSelection 的 modeId。 */
const DIRECT_MODES = [
  { name: "assistant", desc: "conversational mode" },
  { name: "agent", desc: "assistant compatibility alias" },
  { name: "code", desc: "coding mode" },
  { name: "coding", desc: "coding mode (alias of /code)" },
  { name: "yolo", desc: "unattended mode — approvals off" }
]

function switchAndReport({ print, state, ctx, switchModeInPlace }, modeId) {
  const next = switchModeInPlace(state, ctx, modeId)
  print(`mode switched: ${next.icon} ${next.label} (${next.hint})`, { channel: "notice", topic: "mode" })
  return { exit: false }
}

export const modeCommands = [
  {
    names: ["mode", "m"],
    desc: "switch explicit mode",
    argMode: "optional",
    run: (cmd) => {
      const { args, print, state } = cmd
      if (!args) {
        print(`mode: ${formatModeBadge(state.modeId || state.mode)}`, { channel: "notice", topic: "command" })
        return { exit: false, openModePicker: true }
      }
      const modeId = modeIdFromLegacy(args)
      if (!modeId) {
        print(`unknown mode: ${escapeTerminalText(args)} (${MODE_IDS.join(" | ")})`, { channel: "notice", topic: "command", tone: "error" })
        return { exit: false }
      }
      return switchAndReport(cmd, modeId)
    }
  },

  {
    names: ["plan"],
    desc: "read-only development plan",
    argMode: "optional",
    run: (cmd) => {
      const { args, state } = cmd
      if (!args) return switchAndReport(cmd, "plan")
      // 带目标的 /plan：切到 plan 航道，然后把目标包成一段规划指令继续跑。
      state.mode = "plan"
      return {
        rewrite: [
          "Create a read-only development plan for this request.",
          "Do not edit project source files. Inspect the repository as needed, then call enter_plan and exit_plan with the complete plan.",
          "The plan must include goal, scope, implementation steps, impacted modules, tests, risks, and acceptance criteria.",
          "",
          `Request: ${args}`
        ].join("\n")
      }
    }
  },

  {
    names: ["ultra"],
    desc: "persistent staged development",
    argMode: "optional",
    run: (cmd) => {
      const { args, print, state, ctx, switchModeInPlace } = cmd
      if (!args) return switchAndReport(cmd, "ultra")
      switchModeInPlace(state, ctx, "ultra")
      const sub = args.toLowerCase()
      if (sub === "4stage" || sub === "hybrid") {
        // 0.4.0 只剩一套 Ultra 编排，impl 子命令不再有意义
        print(`Ultra 现在只有一套编排，/${sub} 子命令已移除`)
        return { exit: false }
      }
      return { rewrite: args }
    }
  },

  {
    names: ["longagent"],
    desc: "deprecated alias for /ultra",
    argMode: "optional",
    run: (cmd) => {
      const { args, print, state, ctx, switchModeInPlace } = cmd
      if (!args) {
        noteDeprecation("mode.longagent", "`/longagent` 已更名为 `/ultra`")
        return switchAndReport(cmd, "longagent")
      }
      switchModeInPlace(state, ctx, "ultra")
      const sub = args.toLowerCase()
      if (sub === "4stage" || sub === "hybrid") {
        print(`Ultra 现在只有一套编排，/${sub} 子命令已移除`)
        return { exit: false }
      }
      return { rewrite: args }
    }
  },

  ...DIRECT_MODES.map(({ name, desc }) => ({
    names: [name],
    desc,
    argMode: "none",
    run: (cmd) => switchAndReport(cmd, name)
  }))
]
