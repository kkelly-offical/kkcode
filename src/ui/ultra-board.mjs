/**
 * Ultra 看板：目标树 + stage/task + 验收判据投影成五列卡片。
 *
 * 五列与终局状态集同源：**待办 · 进行中 · 受阻 · 待验收 · 已达成**。
 * 「待验收」一列的存在，就是「不把模型的自我声明当成达成」在 UI 上的体现 ——
 * 任务做完了但判据还没核验（或需要人点头）的东西停在这里，不冒充完成。
 *
 * 纯函数两层（模型 + 渲染），三处复用：REPL 回合末尾的紧凑摘要、
 * `/board`、`kkcode ultra board --session [--watch]` 的离线渲染。
 */

export const BOARD_COLUMNS = Object.freeze([
  { key: "todo", title: "待办" },
  { key: "doing", title: "进行中" },
  { key: "blocked", title: "受阻" },
  { key: "pending_check", title: "待验收" },
  { key: "done", title: "已达成" }
])

function taskColumn(status) {
  switch (status) {
    case "completed": return "done"
    case "running": case "retrying": case "pending_launch": return "doing"
    case "error": case "skipped": case "cancelled": return "blocked"
    case "pending": default: return "todo"
  }
}

function criterionColumn(status) {
  switch (status) {
    case "pass": return "done"
    case "fail": return "blocked"
    case "pending_manual": case "unknown": default: return "pending_check"
  }
}

/**
 * @param {object} p
 * @param {object} p.goal          目标树（可 null）
 * @param {object} p.stagePlan     冻结的计划（可 null）
 * @param {object} p.taskProgress  taskId -> 进度
 * @param {object} p.verification  verifyGoal 结果（可 null —— 未核验的判据进「待验收」）
 * @param {object} p.liveTasks     taskId -> { lastLine, elapsedMs }（运行中任务的实时详情，可 null）
 * @returns {{columns: [{key,title,cards}], summary}}
 */
export function buildBoardModel({ goal = null, stagePlan = null, taskProgress = {}, verification = null, liveTasks = null } = {}) {
  const cards = { todo: [], doing: [], blocked: [], pending_check: [], done: [] }
  const stageOwner = new Map()   // stageId -> subGoal title
  for (const sub of goal?.subGoals || []) {
    for (const stageId of sub.stageIds || []) stageOwner.set(stageId, sub.title)
  }

  // task 卡片
  for (const stage of stagePlan?.stages || []) {
    for (const task of stage.tasks || []) {
      const progress = taskProgress[task.taskId] || { status: "pending" }
      const column = taskColumn(progress.status)
      const live = liveTasks?.[task.taskId]
      cards[column].push({
        id: task.taskId,
        kind: "task",
        title: String(task.prompt || task.taskId).slice(0, 60),
        subGoal: stageOwner.get(stage.stageId) || "",
        stageId: stage.stageId,
        status: progress.status || "pending",
        detail: column === "blocked"
          ? String(progress.skipReason || progress.lastError || "").slice(0, 80)
          : (live?.lastLine ? String(live.lastLine).slice(0, 80) : ""),
        files: (task.plannedFiles || []).length
      })
    }
  }

  // 判据卡片。verification 为 null 时全部进「待验收」—— 没核验就不冒充结果
  const verdictById = new Map()
  if (verification) {
    for (const r of verification.results || []) verdictById.set(r.id, r)
    for (const sub of verification.subGoals || []) {
      for (const r of sub.results || []) verdictById.set(r.id, r)
    }
  }
  const pushCriterion = (criterion, subTitle) => {
    const verdict = verdictById.get(criterion.id)
    const column = verdict ? criterionColumn(verdict.status) : "pending_check"
    cards[column].push({
      id: criterion.id,
      kind: "criterion",
      title: String(criterion.text).slice(0, 60),
      subGoal: subTitle,
      status: verdict?.status || "unverified",
      detail: verdict && column !== "done" ? String(verdict.reason || "").slice(0, 80) : "",
      manual: criterion.kind === "manual"
    })
  }
  for (const criterion of goal?.criteria || []) pushCriterion(criterion, "")
  for (const sub of goal?.subGoals || []) {
    for (const criterion of sub.criteria || []) pushCriterion(criterion, sub.title)
  }

  const total = Object.values(cards).reduce((n, list) => n + list.length, 0)
  const summary = {
    total,
    done: cards.done.length,
    doing: cards.doing.length,
    blocked: cards.blocked.length,
    pendingCheck: cards.pending_check.length,
    subGoals: (goal?.subGoals || []).map((sub) => {
      const subCards = Object.entries(cards).flatMap(([key, list]) =>
        list.filter((c) => c.subGoal === sub.title).map((c) => ({ ...c, column: key })))
      const doneCount = subCards.filter((c) => c.column === "done").length
      return { title: sub.title, done: doneCount, total: subCards.length, optional: sub.optional === true }
    })
  }

  return { columns: BOARD_COLUMNS.map(({ key, title }) => ({ key, title, cards: cards[key] })), summary }
}

const COLUMN_COLORS = { todo: null, doing: "cyan", blocked: "red", pending_check: "yellow", done: "green" }
const KIND_MARK = { task: "▪", criterion: "◆" }

/**
 * 渲染看板。
 * @param {object} model buildBoardModel 的产物
 * @param {{width?: number, compact?: boolean, paint?: Function}} options
 *   compact: 每个子目标一行进度 + 受阻计数（回合末尾摘要用，3-5 行不刷屏）
 *   width < 100 时降级为分组列表 —— 窄终端里多列布局不可读
 */
export function renderUltraBoard(model, { width = 120, compact = false, paint = (t) => t } = {}) {
  const dim = (t) => paint(t, null, { dim: true })
  const colored = (t, key) => (COLUMN_COLORS[key] ? paint(t, COLUMN_COLORS[key], { bold: true }) : paint(t, null, { bold: true }))
  const lines = []

  if (compact) {
    const s = model.summary
    const bar = (done, total) => {
      const cells = 12
      const filled = total ? Math.round((done / total) * cells) : 0
      return `${"█".repeat(filled)}${"░".repeat(cells - filled)}`
    }
    if (s.subGoals.length) {
      for (const sub of s.subGoals) {
        lines.push(`  ${bar(sub.done, sub.total)} ${sub.done}/${sub.total} ${sub.title}${sub.optional ? dim(" (optional)") : ""}`)
      }
    } else {
      lines.push(`  ${bar(s.done, s.total)} ${s.done}/${s.total}`)
    }
    const flags = []
    if (s.doing) flags.push(paint(`${s.doing} 进行中`, "cyan"))
    if (s.blocked) flags.push(paint(`${s.blocked} 受阻`, "red"))
    if (s.pendingCheck) flags.push(paint(`${s.pendingCheck} 待验收`, "yellow"))
    if (flags.length) lines.push(`  ${flags.join(dim(" · "))}`)
    return lines
  }

  if (width < 100) {
    // 窄终端：分组列表
    for (const column of model.columns) {
      if (!column.cards.length) continue
      lines.push(colored(`${column.title} (${column.cards.length})`, column.key))
      for (const card of column.cards) {
        const sub = card.subGoal ? dim(` [${card.subGoal}]`) : ""
        lines.push(`  ${KIND_MARK[card.kind] || "·"} ${card.title}${sub}`)
        if (card.detail) lines.push(`      ${dim(card.detail)}`)
      }
      lines.push("")
    }
    return lines
  }

  // 宽终端：五列并排
  const colWidth = Math.max(16, Math.floor((width - 8) / model.columns.length) - 2)
  const clip = (t) => {
    const chars = [...String(t)]
    let w = 0, out = ""
    for (const ch of chars) {
      const cw = /[ᄀ-￿]/.test(ch) ? 2 : 1
      if (w + cw > colWidth) return out + "…"
      out += ch; w += cw
    }
    return out + " ".repeat(Math.max(0, colWidth - w))
  }
  lines.push(model.columns.map((c) => colored(clip(`${c.title} (${c.cards.length})`), c.key)).join("  "))
  lines.push(dim("─".repeat(Math.min(width, (colWidth + 2) * model.columns.length))))
  const depth = Math.max(...model.columns.map((c) => c.cards.length), 0)
  for (let row = 0; row < depth; row++) {
    lines.push(model.columns.map((c) => {
      const card = c.cards[row]
      if (!card) return clip("")
      const mark = KIND_MARK[card.kind] || "·"
      const sub = card.subGoal ? `[${card.subGoal.slice(0, 8)}] ` : ""
      return clip(`${mark} ${sub}${card.title}`)
    }).join("  "))
  }
  return lines
}
