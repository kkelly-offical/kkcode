/**
 * 公开航道契约：纯数据 + 纯函数，无依赖的叶子模块。
 *
 * 这段此前住在 engine.mjs，而 system-prompt.mjs 为了 renderPublicModeContract
 * 回向 import engine，闭上 engine → loop → system-prompt → engine 的 8 文件
 * SCC（M3 §四.1）。1.0.0 阶段 1b 把它下沉到这里：system-prompt 改 import 本
 * 模块，engine.mjs 做兼容再导出，公开导出面与运行时行为完全不变。
 */

export const PUBLIC_MODE_CONTRACT = Object.freeze([
  {
    mode: "assistant",
    summary: "default CLI personal assistant lane",
    guarantee: "assistant handles bounded terminal-native personal assistant work under normal tool permissions"
  },
  {
    mode: "plan",
    summary: "produce a spec/plan only",
    guarantee: "plan does not execute file mutations"
  },
  {
    mode: "agent",
    summary: "compatibility alias for assistant",
    guarantee: "agent/code/coding resolve to the unified assistant (since 0.3.0)"
  },
  {
    mode: "longagent",
    summary: "heavyweight staged multi-file delivery lane",
    guarantee: "longagent stays reserved for structured multi-file or system-level work"
  }
])

/**
 * 归一到执行航道。0.4.0 的公开模式名（agent / agent-auto / ultra）在这里
 * 也被接受，但航道取值刻意保持 0.3.x 的三个值，运行时无需改动。
 */
export function resolveMode(inputMode = "assistant") {
  const mode = String(inputMode || "assistant").toLowerCase()
  if (mode === "ultra") return "longagent"
  if (mode === "auto" || mode === "agent-auto" || mode === "yolo") return "assistant"
  if (mode === "agent" || mode === "code" || mode === "coding" || mode === "ask") return "assistant"
  if (["assistant", "plan", "longagent"].includes(mode)) return mode
  return "assistant"
}

export function getPublicModeContract(inputMode = "assistant") {
  const mode = resolveMode(inputMode)
  return PUBLIC_MODE_CONTRACT.find((item) => item.mode === mode) || PUBLIC_MODE_CONTRACT[0]
}

export function formatPublicModeSummary(inputMode = "assistant") {
  const contract = getPublicModeContract(inputMode)
  return `${contract.mode}: ${contract.summary}`
}

export function renderPublicModeContract() {
  return [
    "# Mode Contract",
    "",
    "- `assistant`: default CLI personal assistant lane for bounded terminal-native personal work, explanation, and analysis.",
    "- `plan`: produce a spec/plan only; do not execute file mutations.",
    "- `agent` / `code` / `coding`: compatibility aliases for `assistant` (since 0.3.0).",
    "- `longagent`: heavyweight staged multi-file delivery lane with explicit gates.",
    "- Keep everyday Q&A, coding mutation, debugging, refactoring, and test repair in `assistant`.",
    "- Suggest `longagent` only when heavy multi-file or system-level evidence appears; do not auto-switch.",
    "- Keep `plan` explicit and mutation-free even when later execution is likely.",
    "",
    "The user-facing names for these lanes (since 0.4.0) are Plan, Agent, Agent · Auto,",
    "Ultra and YOLO; Ultra is the `longagent` lane and the rest run on `assistant`.",
    "The difference between Agent, Agent · Auto and YOLO is the approval level, not",
    "the lane: never assume an edit is pre-approved, always let the permission layer decide."
  ].join("\n")
}
