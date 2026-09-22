import { paint } from "../theme/color.mjs"
import { formatThinkingDuration } from "./thinking-state.mjs"
import { turnPhaseOf } from "./turn-runtime.mjs"

/**
 * 输入框上方的那条忙碌行（busy line）。
 *
 * 从 frame-builder 抽出来的理由：buildFrame 的判定点在结构守卫里只减不增，
 * 而这一块的文案分派（工具/写作/重试/压缩/思考/等待/空窗/收尾）本身值得独立断言。
 *
 * 文案按**回合相位**分派（ui/turn-runtime.mjs）：
 *   - active：当前活动在做什么就显示什么（tool/writing/retry/compacting/thinking/waiting）
 *   - starting：已受理、首个 step 事件未到的空窗
 *   - finishing：回合已结束、正在呈现结果 —— 绝不能再显示成 "Starting"/"Thinking"，
 *     那是「回合结束后又开始思考」这个 bug 的可见形态
 */

export const BUSY_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function clipBusy(text, max) {
  const s = String(text || "").trim().split("\n")[0]
  return s.length > max ? s.slice(0, max - 3) + "..." : s
}

export function formatBusyToolDetail(toolName, args) {
  if (!args) return ""
  switch (toolName) {
    case "bash": return args.command ? paint(` ${clipBusy(args.command, 60)}`, null, { dim: true }) : ""
    case "read": return args.path ? paint(` ${clipBusy(args.path, 60)}`, null, { dim: true }) : ""
    case "write": return args.path ? paint(` ${clipBusy(args.path, 60)}`, null, { dim: true }) : ""
    case "edit": return args.path ? paint(` ${clipBusy(args.path, 60)}`, null, { dim: true }) : ""
    case "notebookedit": return args.path ? paint(` ${clipBusy(args.path, 50)} cell ${args.cell_number ?? 0}`, null, { dim: true }) : ""
    case "grep": return args.pattern ? paint(` ${clipBusy(args.pattern, 40)}`, null, { dim: true }) : ""
    case "glob": return args.pattern ? paint(` ${clipBusy(args.pattern, 40)}`, null, { dim: true }) : ""
    case "patch": return args.path ? paint(` ${clipBusy(args.path, 40)} L${args.start_line || "?"}-${args.end_line || "?"}`, null, { dim: true }) : ""
    case "task": return args.description ? paint(` ${clipBusy(args.description, 50)}`, null, { dim: true }) : ""
    case "enter_plan": return args.reason ? paint(` ${clipBusy(args.reason, 50)}`, null, { dim: true }) : paint(" planning...", null, { dim: true })
    case "exit_plan": return paint(" submitting plan...", null, { dim: true })
    default: return ""
  }
}

export function buildBusyLine({ ui, theme, now = Date.now() }) {
  if (!ui.busy) return ""
  // 点数动画统一补到固定 3 格：不补的话后面的 · 03s 会跟着点左右横跳。
  const dots = ".".repeat((ui.spinnerIndex % 3) + 1).padEnd(3)
  const spinner = BUSY_SPINNER_FRAMES[ui.spinnerIndex % BUSY_SPINNER_FRAMES.length]
  const stepTag = ui.currentStep > 0
    ? paint(` [${ui.currentStep}/${ui.maxSteps || "?"}]`, "cyan", { dim: true })
    : ""

  if (ui.currentActivity) {
    const activity = ui.currentActivity
    if (activity.type === "tool") {
      const toolName = activity.tool || "tool"
      const toolColor = toolName === "edit" || toolName === "write" || toolName === "notebookedit" ? "yellow"
        : toolName === "bash" ? "magenta"
        : "cyan"
      return `${paint(spinner, toolColor)} ${paint(toolName, toolColor, { bold: true })}${formatBusyToolDetail(toolName, activity.args)}${stepTag}`
    }
    if (activity.type === "writing") {
      return `${paint(spinner, "green")} ${paint("writing", "green", { bold: true })}${stepTag}`
    }
    if (activity.type === "retry") {
      const attempt = activity.attempt || "?"
      const max = activity.max || "?"
      const why = activity.classification
        ? paint(` · ${activity.classification}`, null, { dim: true })
        : ""
      return `${paint(spinner, theme.semantic.warn)} ${paint(`Retrying ${attempt}/${max}${dots}`, theme.semantic.warn, { bold: true })}${why}${stepTag}`
    }
    if (activity.type === "compacting") {
      return `${paint(spinner, theme.semantic.warn)} ${paint(`Compacting${dots}`, theme.semantic.warn, { bold: true })}${stepTag}`
    }
    if (ui.thinking.phase === "streaming") {
      // 推理流：有真实的 thinking 内容在到达，计时从等待起点累计
      const elapsed = ui.thinking.startedAt
        ? formatThinkingDuration(now - ui.thinking.startedAt)
        : "0.0s"
      return `${paint(spinner, theme.semantic.warn)} ${paint(`Thinking${dots} · ${elapsed}`, theme.semantic.warn, { bold: true })}${stepTag}`
    }
    // 等首个 token（含工具结束到下一 step 的间隙）：thinking 与 waiting 是两个状态。
    // phase 不是 waiting 时没有计时锚点（startedAt=0），宁缺毋滥 —— 不显示 0.0s。
    const timer = ui.thinking.startedAt
      ? ` · ${formatThinkingDuration(now - ui.thinking.startedAt)}`
      : ""
    return `${paint(spinner, theme.semantic.warn)} ${paint(`Waiting${dots}${timer}`, theme.semantic.warn, { bold: true })}${stepTag}`
  }

  // 回合已结束、结果正在呈现：安安静静收尾，不像一次新的思考。
  if (turnPhaseOf(ui) === "finishing") {
    return `${paint("✓", theme.semantic.success)} ${paint("Finishing…", theme.base.muted, { dim: true })}`
  }

  // 回合已提交但第一个 step 事件还没到（路由/读历史/压缩检查），以及
  // longagent 阶段之间的间隙：此前这里显示 Thinking · 0.0s，计时是冻结的。
  const label = ui.metrics?.longagent ? "Working" : "Starting"
  return `${paint(spinner, theme.semantic.warn)} ${paint(`${label}${dots}`, theme.semantic.warn, { bold: true })}`
}
