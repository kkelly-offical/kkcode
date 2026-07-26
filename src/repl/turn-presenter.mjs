/**
 * 一个回合的结果 → 各个输出通道。
 *
 * 此前这段逻辑有**两份**：正常提交走一份（含状态行、文件变更、诊断、Ultra 看板），
 * `/paste <文字>` 走另一份（只有状态行与回复）。两份都自己组装返回给调用方的
 * `turnResult`，而其中一份**漏了 `costSavings`** —— 于是状态栏那个
 * `COST $x ↓$y` 的 `↓y`（提示词缓存省下多少）只在 `/paste` 之后出现过，正常回合
 * 永远是 0。engine 在算它，status-bar 有位置显示它，中间这一步把它丢了。
 *
 * 合并成一处之后，「回合结果有哪些字段」只有一个答案。代价是 `/paste <文字>` 现在
 * 也会列出文件变更与诊断 —— 那是它本来就该有的，只是当初复制时没带上。
 */

import { renderMarkdown } from "../theme/markdown.mjs"
import { paint } from "../theme/color.mjs"
import { renderReplStatusLine } from "../ui/repl-status-view.mjs"
import {
  normalizeDiagnostics,
  normalizeFileChanges,
  renderDiagnosticsLines,
  renderFileChangeLines
} from "../ui/repl-turn-summary.mjs"
import { renderBlockedReportText } from "../session/blocked-report.mjs"
import { buildBoardModel, renderUltraBoard } from "../ui/ultra-board.mjs"
import { renderTaskProgressPanel } from "../ui/repl-task-panel.mjs"
import { formatPlanProgress, formatRecoverySuggestions } from "../ui/activity-renderer.mjs"
import { executePromptTurn } from "./turn-controller.mjs"

/** 回合结果里要回传给 UI 的字段。单一定义 —— 此前两处各写一份，一处漏了 costSavings。 */
function toTurnResult(result) {
  return {
    tokenMeter: result.tokenMeter,
    cost: result.cost,
    costSavings: result.costSavings,
    context: result.context,
    longagent: result.longagent,
    toolEvents: result.toolEvents
  }
}

/**
 * 跑一个回合并把结果呈现出来。
 *
 * @param {object} p
 * @param {string} p.prompt
 * @param {object[]} [p.images]  随本轮发送的图片
 * @param {object} p.state
 * @param {object} p.ctx
 * @param {Function} p.print
 * @param {Function|null} [p.streamSink]
 * @param {boolean} [p.showTurnStatus] 行模式打状态行；TUI 有状态栏，不重复打
 * @param {AbortSignal|null} [p.signal]
 * @param {Function} [p.switchModeInPlace] Plan 审批选了执行航道时用它真正切模式
 * @returns {Promise<object>} action
 */
export async function presentPromptTurn({
  prompt,
  images = [],
  state,
  ctx,
  print,
  streamSink = null,
  showTurnStatus = true,
  signal = null,
  switchModeInPlace = null
}) {
  const turn = await executePromptTurn({
    prompt,
    state,
    ctx,
    streamSink: state.mode === "longagent" ? null : streamSink,
    pendingImages: images,
    signal
  })
  const result = turn.result

  const status = renderReplStatusLine({
    state,
    configState: ctx.configState,
    theme: ctx.themeState.theme,
    tokenMeter: result.tokenMeter,
    cost: result.cost,
    costSavings: result.costSavings,
    contextMeter: result.context,
    longagentState: result.longagent
  })
  if (showTurnStatus) print(status)

  const toolFileChanges = normalizeFileChanges(result.toolEvents)
  const longagentFileChanges = normalizeFileChanges(
    Array.isArray(result.longagent?.fileChanges)
      ? result.longagent.fileChanges.map((item) => ({
          name: "write",
          metadata: { fileChanges: [item] }
        }))
      : []
  )
  const fileChanges = state.mode === "longagent" && longagentFileChanges.length
    ? longagentFileChanges
    : toolFileChanges
  const diagnostics = normalizeDiagnostics(result.toolEvents)

  if (state.mode === "longagent") {
    if (result.longagent) {
      if (result.longagent.goal) {
        // 0.5.0：目标看板的紧凑形态（每个子目标一行进度 + 受阻/待验收计数），
        // 取代旧的 "longagent: phase=… stage=…" 单行
        const board = buildBoardModel({
          goal: result.longagent.goal,
          stagePlan: result.longagent.stagePlan,
          taskProgress: result.longagent.taskProgress || {},
          verification: result.longagent.goalVerification
        })
        for (const line of renderUltraBoard(board, { compact: true, paint })) print(line)
      } else {
        const stg = result.longagent.currentStageId
          ? result.longagent.currentStageId
          : `${(result.longagent.stageIndex || 0) + 1}/${Math.max(1, result.longagent.stageCount || 1)}`
        print(`longagent: phase=${result.longagent.phase || "-"} stage=${stg} gate=${result.longagent.currentGate || "-"}`)
      }
      if (result.longagent.taskProgress && Object.keys(result.longagent.taskProgress).length) {
        for (const line of renderTaskProgressPanel(result.longagent.taskProgress, formatPlanProgress)) print(line)
      }
      // 受阻报告优先（从 ledger 生成的结构化报告，带判据与证据）；
      // 没有报告时退回 recoverySuggestions —— 后者从 0.3.x 起就在生成，
      // 但 engine 打包时没有透传，全代码库零消费者，用户从来没见过它。
      if (result.longagent.blockedReport && result.longagent.status !== "completed") {
        for (const line of renderBlockedReportText(result.longagent.blockedReport, { paint })) print(line)
      } else if (result.longagent.recoverySuggestions) {
        for (const line of formatRecoverySuggestions(result.longagent.recoverySuggestions)) print(line)
      }
    }
    if (fileChanges.length) {
      print(paint("changed files:", "cyan", { bold: true }))
      for (const line of renderFileChangeLines(fileChanges)) print(line)
    }
    if (diagnostics.length) {
      print(paint("diagnostics:", "yellow", { bold: true }))
      for (const line of renderDiagnosticsLines(diagnostics, 6)) print(line)
    } else if (!result.emittedText && result.reply) {
      const mdEnabled = ctx.configState.config.ui?.markdown_render !== false
      print(mdEnabled ? renderMarkdown(result.reply) : result.reply)
    }
  } else {
    if (!result.emittedText) {
      const mdEnabled = ctx.configState.config.ui?.markdown_render !== false
      print(mdEnabled ? renderMarkdown(result.reply) : result.reply)
    }
    if (fileChanges.length) {
      print(paint("changed files:", "cyan", { bold: true }))
      for (const line of renderFileChangeLines(fileChanges, 10)) print(line)
    }
    if (diagnostics.length) {
      print(paint("diagnostics:", "yellow", { bold: true }))
      for (const line of renderDiagnosticsLines(diagnostics, 6)) print(line)
    }
  }

  // Plan 审批选择了执行航道 → 真正切模式（0.3.x 只把选择塞回提示词）
  let planHandoff = null
  if (result.planHandoff?.modeId && switchModeInPlace) {
    const next = switchModeInPlace(state, ctx, result.planHandoff.modeId)
    planHandoff = { ...result.planHandoff, label: next.label, icon: next.icon }
    print(`mode switched: ${next.icon} ${next.label} (plan build)`, { channel: "notice", topic: "mode" })
  }

  return {
    exit: false,
    planHandoff,
    turnResult: toTurnResult(result)
  }
}
