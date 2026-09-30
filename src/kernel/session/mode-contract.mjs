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
    summary: "complete coding, task, verification and delegation lane",
    guarantee: "Agent, Auto and Yolo share complete execution capabilities and differ only in approval policy"
  },
  {
    mode: "plan",
    summary: "read-only exploration, delegated analysis and durable planning",
    guarantee: "plan does not mutate project files; session-owned ToDo updates and explicitly scoped read-only delegation remain available"
  },
  {
    mode: "agent",
    summary: "compatibility alias for assistant",
    guarantee: "agent/code/coding resolve to the unified assistant (since 0.3.0)"
  },
  {
    mode: "longagent",
    summary: "durable staged orchestration over complete execution capabilities",
    guarantee: "Ultra adds durable stages, ownership and verification gates; it does not reserve coding capabilities from other execution modes"
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
    "- `assistant`: complete coding, task execution, verification and delegation capabilities for Agent, Auto and Yolo.",
    "- `plan`: read-only project exploration, scoped read-only delegated analysis and durable session ToDo state; never mutate project files.",
    "- `agent` / `code` / `coding`: compatibility aliases for `assistant` (since 0.3.0).",
    "- `longagent`: the same execution capabilities with durable staged orchestration and explicit gates.",
    "- Keep everyday Q&A, coding mutation, debugging, refactoring, and test repair in `assistant`.",
    "- Ultra is an optional orchestration overlay, not a prerequisite for complex implementation; do not auto-switch.",
    "- Keep `plan` explicit and project-mutation-free even when later execution is likely; ToDo updates do not authorize execution.",
    "",
    "The user-facing names are Plan, Agent, Auto, Ultra and Yolo. Ultra uses the",
    "`longagent` lane; Agent, Auto and Yolo use `assistant`. Auto permits routine edits",
    "and reviews sensitive actions with the conversation model. Yolo skips routine confirmations",
    "within the user's authorized scope; it never weakens organization rules, side-effect accounting or verification. Always let the permission layer decide."
  ].join("\n")
}
