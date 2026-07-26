/**
 * Ultra 结果汇报：从 ledger 组装结构化报告，渲染成终端文本或 Markdown。
 *
 * 名字里的 "blocked" 是历史遗留 —— 它同时服务**成功路径**（`status:
 * "completed"` 时也走这里），而成功时最该留档的恰恰是「凭什么说做完了」：
 * 判据逐条的判定与证据、改过哪些文件、以及门禁跑出来的结果。
 * 0.7.0 补上最后一项：门禁结果一直存在 ledger 里，却从未出现在报告中。
 *
 * 三个铁律：
 *   1. **只读 ledger**，不读运行期变量 —— 会话结束时的渲染与事后
 *      `kkcode ultra report` 必须是同一条码，不允许「当时显示的和事后查的不一样」。
 *   2. gate 与判据的 output snippet 原样保留 —— 0.4.x 把它们压成
 *      `build:build failed with code 1`，用户和模型都只能靠猜。
 *   3. 模板版报告不依赖 LLM 摘要 —— llmSummary 是可选的增强，抛错就没有，
 *      报告的其余部分必须完整可用。
 */

const STATUS_LABELS = {
  completed: "已完成", partial: "部分完成", blocked: "受阻",
  blocked_manual: "待人工确认", user_stopped: "已停止",
  budget_exhausted: "预算耗尽", deadline_exhausted: "超时",
  plan_rejected: "已取消", needs_objective: "需要明确目标", fatal: "内部错误"
}

const MARKS = { pass: "✓", fail: "✗", unknown: "?", pending_manual: "…" }

function elapsedText(ledger) {
  const start = Date.parse(ledger.data.startedAt || "")
  const end = Date.parse(ledger.data.endedAt || "") || Date.now()
  if (!start) return ""
  const minutes = Math.round((end - start) / 60000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes} 分钟`
}

/**
 * @param {import("./ultra-ledger.mjs").UltraLedger} ledger
 * @param {{status?: string, llmSummary?: {headline?: string, nextSteps?: string[]}|null}} extra
 */
export function buildBlockedReport(ledger, { status = "", llmSummary = null } = {}) {
  const data = ledger.data
  const finalStatus = status || data.finalStatus || "blocked"
  const lastRound = data.rounds[data.rounds.length - 1] || null
  const criteria = lastRound?.criteria || []

  const achieved = criteria.filter((c) => c.status === "pass")
    .map((c) => ({ id: c.id, what: c.text, evidence: c.reason }))

  const blockerById = new Map(data.blockers.map((b) => [b.criterionId, b]))
  const blocked = criteria.filter((c) => c.status === "fail")
    .map((c) => {
      const blocker = blockerById.get(c.id)
      return {
        id: c.id, criterion: c.text, why: c.reason,
        evidence: c.evidence || {},
        attempts: blocker?.attempts || 1,
        rounds: blocker ? [blocker.firstSeenRound, blocker.lastSeenRound] : [lastRound?.round || 1]
      }
    })

  const manualPending = criteria.filter((c) => c.status === "pending_manual")
    .map((c) => ({ id: c.id, criterion: c.text, question: c.reason }))

  const unknown = criteria.filter((c) => c.status === "unknown")
    .map((c) => ({ id: c.id, criterion: c.text, why: c.reason }))

  // 被删掉的 blocking 判据强制展示 —— 修订留痕的最后一环
  const criteriaChanged = (data.goal?.revisions || []).flatMap((rev) =>
    (rev.removed || []).map((r) => ({ id: r.id, text: r.text, reason: r.reason || rev.reason, round: rev.round }))
  )

  const attempts = data.rounds.map((round) => ({
    round: round.round,
    replanReason: round.replanReason,
    whatWasTried: round.stages.map((s) => `${s.stageId}${s.disposition ? `(${s.disposition})` : ""}`).join(", "),
    whatFailed: round.stages.flatMap((s) => s.failedTasks.map((t) => `${t.taskId}: ${t.error}`)).slice(0, 5),
    madeProgress: round.progress ? round.progress.madeProgress : null,
    progressReason: round.progress?.reason || ""
  }))

  const filesChanged = lastRound?.fileChanges || []
  const subGoals = lastRound?.subGoals || []
  const totals = { pass: achieved.length, total: criteria.length }

  // 门禁结果。此前 ledger 里存着但报告从不读 —— 于是「六道门禁全过」这个
  // 结论只存在于日志里，报告读者无从确认。禁用的门禁不列：它没有发言权，
  // 列出来只会让人以为它通过了。
  const gateEntries = Object.entries(lastRound?.gates || {})
    .filter(([, gate]) => gate && gate.status !== "disabled")
    .map(([name, gate]) => ({
      gate: name,
      status: gate.status,
      reason: gate.reason || "",
      outputSnippet: gate.outputSnippet || "",
      evidence: gate.evidence || null
    }))

  // 运行时证据：架构图里 Runtime → Logs 那一段的落点。其余五道门禁都是静态
  // 检查，只有 smoke 真的把产物跑起来过，所以只有它能回答「跑起来了吗」。
  const smoke = gateEntries.find((g) => g.gate === "smoke")
  const runtimeEvidence = smoke?.evidence
    ? {
        ran: smoke.status === "pass",
        target: smoke.evidence.target,
        kind: smoke.evidence.kind,
        exitCode: smoke.evidence.exitCode,
        timedOut: smoke.evidence.timedOut,
        crashSignatures: smoke.evidence.crashSignatures || []
      }
    : null

  return {
    status: finalStatus,
    statusLabel: STATUS_LABELS[finalStatus] || finalStatus,
    objective: data.objective,
    sessionId: data.sessionId,
    roundsUsed: data.rounds.length,
    elapsed: elapsedText(ledger),
    headline: llmSummary?.headline || "",
    nextSteps: llmSummary?.nextSteps || [],
    totals, achieved, blocked, unknown, manualPending, criteriaChanged,
    subGoals, attempts, filesChanged,
    gates: gateEntries, runtimeEvidence,
    userInteractions: data.userInteractions,
    planDefects: data.planDefects,
    resumeHint: `kkcode ultra resume --session ${data.sessionId}`,
    ledgerPath: ledger.path
  }
}

/** 终端文本渲染。paint 注入以避免对 theme 的硬依赖（CLI 无色输出传恒等函数）。 */
export function renderBlockedReportText(report, { paint = (t) => t } = {}) {
  const lines = []
  const dim = (t) => paint(t, null, { dim: true })
  const bold = (t, color) => paint(t, color, { bold: true })

  lines.push(bold(`Ultra ${report.statusLabel}`, report.status === "completed" ? "green" : "yellow"))
  lines.push(`目标: ${report.objective}`)
  const meta = [`${report.roundsUsed} 轮`, report.elapsed].filter(Boolean).join(" / ")
  if (meta) lines.push(dim(meta))
  lines.push("")

  if (report.subGoals.length) {
    lines.push(bold("子目标", "cyan"))
    for (const sub of report.subGoals) {
      const mark = sub.status === "met" ? "✓" : sub.status === "unmet" ? "✗" : "…"
      lines.push(`  ${mark} ${sub.title}${sub.optional ? dim(" (optional)") : ""} — ${sub.status}`)
    }
    lines.push("")
  }

  if (report.achieved.length) {
    lines.push(bold(`已达成 (${report.totals.pass}/${report.totals.total})`, "green"))
    for (const item of report.achieved) lines.push(`  ${MARKS.pass} ${item.what}`)
    lines.push("")
  }

  const failing = [...report.blocked, ...report.unknown.map((u) => ({ ...u, criterion: u.criterion, why: u.why, evidence: {}, attempts: 0, unknown: true }))]
  if (failing.length) {
    lines.push(bold(`未达成 (${report.blocked.length + report.unknown.length}/${report.totals.total})`, "red"))
    for (const item of report.blocked) {
      const tries = item.attempts > 1 ? ` — 尝试 ${item.attempts} 次，第 ${item.rounds[0]}–${item.rounds[1]} 轮` : ""
      lines.push(`  ${MARKS.fail} ${item.criterion}${dim(tries)}`)
      lines.push(`      ${dim(item.why)}`)
      if (item.evidence.outputSnippet) {
        for (const row of item.evidence.outputSnippet.split(" | ").slice(0, 12)) {
          lines.push(`      ${dim("| " + row)}`)
        }
      }
    }
    for (const item of report.unknown) {
      lines.push(`  ${MARKS.unknown} ${item.criterion} ${dim(`— 无法判定：${item.why}`)}`)
    }
    lines.push("")
  }

  if (report.manualPending.length) {
    lines.push(bold("需要你确认", "yellow"))
    for (const item of report.manualPending) lines.push(`  ${MARKS.pending_manual} ${item.question}`)
    lines.push("")
  }

  if (report.criteriaChanged.length) {
    lines.push(bold("验收标准变更", "yellow"))
    for (const item of report.criteriaChanged) {
      lines.push(`  - 「${item.text}」在第 ${item.round} 轮被删除，理由: ${item.reason || "(未给出)"}`)
    }
    lines.push("")
  }

  if (report.headline) {
    lines.push(bold("关键判断", "cyan"))
    lines.push(`  ${report.headline}`)
    lines.push("")
  }
  if (report.nextSteps.length) {
    lines.push(bold("需要你做的", "cyan"))
    report.nextSteps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`))
    lines.push("")
  }

  if (report.gates.length) {
    const marks = { pass: MARKS.pass, not_applicable: "–" }
    lines.push(bold("门禁", "cyan"))
    for (const gate of report.gates) {
      const mark = marks[gate.status] || MARKS.fail
      const color = gate.status === "pass" ? null : gate.status === "not_applicable" ? null : "red"
      lines.push(`  ${mark} ${gate.gate}${gate.reason ? dim(` — ${gate.reason}`) : ""}`)
      if (gate.status !== "pass" && gate.status !== "not_applicable" && gate.outputSnippet) {
        lines.push(`      ${dim(gate.outputSnippet)}`)
      }
      void color
    }
    lines.push("")
  }

  // 运行时证据独立成段：其余门禁答的是「看起来没坏」，这段答的是
  // 「真的跑起来了，而且是这么跑的」—— 成功路径上最值得留档的一句。
  if (report.runtimeEvidence) {
    const rt = report.runtimeEvidence
    lines.push(bold("运行时证据", rt.ran ? "green" : "red"))
    lines.push(`  ${rt.ran ? MARKS.pass : MARKS.fail} ${rt.target}${dim(` (exit ${rt.exitCode ?? "?"})`)}`)
    if (rt.timedOut) lines.push(`      ${dim("超时被终止")}`)
    for (const sig of rt.crashSignatures) lines.push(`      ${dim(sig)}`)
    lines.push("")
  }

  if (report.filesChanged.length) {
    lines.push(dim(`文件变更 ${report.filesChanged.length} 个：` +
      report.filesChanged.slice(0, 8).map((f) => f.path).join(", ") +
      (report.filesChanged.length > 8 ? ` 等` : "")))
  }
  lines.push(dim(`恢复: ${report.resumeHint}`))
  lines.push(dim(`记录: ${report.ledgerPath}`))
  return lines
}

/** Markdown 渲染（落盘 report.md 用）。 */
export function renderBlockedReportMarkdown(report) {
  const lines = [
    `# Ultra ${report.statusLabel}`,
    "",
    `**目标**: ${report.objective}`,
    `**会话**: \`${report.sessionId}\` · ${report.roundsUsed} 轮${report.elapsed ? ` · ${report.elapsed}` : ""}`,
    ""
  ]
  if (report.subGoals.length) {
    lines.push("## 子目标", "")
    for (const sub of report.subGoals) {
      lines.push(`- ${sub.status === "met" ? "✅" : sub.status === "unmet" ? "❌" : "⏳"} **${sub.title}**${sub.optional ? " *(optional)*" : ""} — ${sub.status}`)
    }
    lines.push("")
  }
  lines.push(`## 验收判据 (${report.totals.pass}/${report.totals.total})`, "")
  for (const item of report.achieved) lines.push(`- ✅ ${item.what}`)
  for (const item of report.blocked) {
    lines.push(`- ❌ ${item.criterion}${item.attempts > 1 ? `（尝试 ${item.attempts} 次，第 ${item.rounds[0]}–${item.rounds[1]} 轮）` : ""}`)
    lines.push(`  - ${item.why}`)
    if (item.evidence.outputSnippet) {
      lines.push("", "  ```", ...item.evidence.outputSnippet.split(" | ").slice(0, 12).map((r) => `  ${r}`), "  ```", "")
    }
  }
  for (const item of report.unknown) lines.push(`- ❓ ${item.criterion} — 无法判定：${item.why}`)
  for (const item of report.manualPending) lines.push(`- ⏳ ${item.question}（待人工确认）`)
  lines.push("")

  if (report.criteriaChanged.length) {
    lines.push("## 验收标准变更", "")
    for (const item of report.criteriaChanged) {
      lines.push(`- 「${item.text}」在第 ${item.round} 轮被删除 — ${item.reason || "(未给出理由)"}`)
    }
    lines.push("")
  }
  if (report.headline) lines.push("## 关键判断", "", report.headline, "")
  if (report.nextSteps.length) {
    lines.push("## 需要你做的", "")
    report.nextSteps.forEach((step, index) => lines.push(`${index + 1}. ${step}`))
    lines.push("")
  }
  if (report.attempts.length) {
    lines.push("## 每轮尝试", "")
    for (const attempt of report.attempts) {
      lines.push(`### 第 ${attempt.round} 轮${attempt.replanReason ? ` — 重规划：${attempt.replanReason}` : ""}`)
      lines.push(`- 执行: ${attempt.whatWasTried || "(无)"}`)
      for (const failure of attempt.whatFailed) lines.push(`- 失败: ${failure}`)
      if (attempt.madeProgress != null) lines.push(`- 进展: ${attempt.madeProgress ? "有" : "无"} — ${attempt.progressReason}`)
      lines.push("")
    }
  }
  if (report.gates.length) {
    lines.push("## 门禁", "")
    for (const gate of report.gates) {
      const icon = gate.status === "pass" ? "✅" : gate.status === "not_applicable" ? "➖" : "❌"
      lines.push(`- ${icon} **${gate.gate}** — ${gate.reason || gate.status}`)
      if (gate.status !== "pass" && gate.status !== "not_applicable" && gate.outputSnippet) {
        lines.push("", "  ```", ...gate.outputSnippet.split(" | ").slice(0, 12).map((r) => `  ${r}`), "  ```", "")
      }
    }
    lines.push("")
  }
  if (report.runtimeEvidence) {
    const rt = report.runtimeEvidence
    lines.push("## 运行时证据", "")
    lines.push(`- ${rt.ran ? "✅" : "❌"} \`${rt.target}\` — exit ${rt.exitCode ?? "?"}${rt.timedOut ? "（超时被终止）" : ""}`)
    for (const sig of rt.crashSignatures) lines.push(`  - ${sig}`)
    lines.push("")
  }
  if (report.filesChanged.length) {
    lines.push("## 文件变更", "")
    for (const file of report.filesChanged) lines.push(`- \`${file.path}\` (+${file.added}/-${file.removed})`)
    lines.push("")
  }
  lines.push("---", `恢复: \`${report.resumeHint}\``, `记录: \`${report.ledgerPath}\``)
  return lines.join("\n")
}
