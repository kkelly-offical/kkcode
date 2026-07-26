import path from "node:path"
import { mkdir } from "node:fs/promises"
import { readJson, writeJsonAtomic } from "../storage/json-store.mjs"
import { projectRootDir } from "../storage/paths.mjs"

/**
 * Ultra 尝试台账：每一轮做了什么、失败了什么、有没有进展。
 *
 * 它同时是三样东西的数据源：
 *   1. **重规划的输入** —— snapshotForReplan() 把失败证据喂回 blueprint agent，
 *      「禁止重复上一轮已失败的路线」只有在记得上一轮做了什么时才可能。
 *   2. **受阻报告的唯一数据源** —— blocked-report 只读 ledger，不读运行期变量，
 *      所以会话结束时的渲染与事后 `kkcode ultra report` 走同一条码。
 *   3. `ultra plan` / `ultra report` 命令的落盘依据。
 *
 * 为什么不复用现成的三套记忆：project_memory 的内容会注入**每个** preview
 * prompt（把失败史塞进去 = 每次会话都为上次的失败付上下文费）；task_bus 纯
 * 内存，进程结束即失；taskProgress.lastError 只在会话内有效。
 *
 * 落盘 .kkcode/ultra/<sessionId>/ledger.json —— 项目级，用户看得见，
 * 不会被 checkpoint 清理策略删掉。
 */

const LEDGER_VERSION = 1
const MAX_FILE_CHANGES_PER_ROUND = 200
const MAX_FAILED_TASKS_PER_ROUND = 50
const MAX_SNIPPET_CHARS = 2000

export function ultraSessionDir(sessionId, cwd = process.cwd()) {
  return path.join(projectRootDir(cwd), "ultra", sessionId)
}

export function ledgerPath(sessionId, cwd = process.cwd()) {
  return path.join(ultraSessionDir(sessionId, cwd), "ledger.json")
}

function clampSnippet(text) {
  return String(text || "").slice(0, MAX_SNIPPET_CHARS)
}

function normalizeGates(gates) {
  const out = {}
  for (const [name, gate] of Object.entries(gates || {})) {
    if (!gate || typeof gate !== "object") continue
    out[name] = {
      status: gate.status || "unknown",
      reason: String(gate.reason || "").slice(0, 300),
      outputSnippet: clampSnippet(gate.output || gate.outputSnippet || "")
    }
    // smoke 门禁带 evidence（入口点、退出码、崩溃签名）—— 那是全套门禁里
    // 唯一的运行时证据，也是成功路径最值得留档的一项：静态检查全过只说明
    // 「看起来没坏」，evidence 说明「真的跑起来了，而且是这么跑的」。
    if (gate.evidence && typeof gate.evidence === "object") {
      out[name].evidence = {
        target: String(gate.evidence.target || "").slice(0, 200),
        kind: String(gate.evidence.kind || ""),
        exitCode: gate.evidence.exitCode ?? null,
        timedOut: Boolean(gate.evidence.timedOut),
        crashSignatures: Array.isArray(gate.evidence.crashSignatures)
          ? gate.evidence.crashSignatures.slice(0, 5)
          : []
      }
    }
  }
  return out
}

export class UltraLedger {
  constructor({ sessionId, cwd = process.cwd(), data, maxRoundsKept = 10 }) {
    this.sessionId = sessionId
    this.cwd = cwd
    this.path = ledgerPath(sessionId, cwd)
    this.data = data
    this.maxRoundsKept = Math.max(1, Number(maxRoundsKept) || 10)
  }

  /** 记一轮。stages / criteria / gates 已在这里裁剪，调用方不必操心大小。 */
  async appendRound({
    round, replanReason = "", planSignature = "",
    stages = [], fileChanges = [], gates = {}, criteria = [], subGoals = [],
    progress = null, degradations = [], usage = null, verdict = ""
  }) {
    this.data.rounds.push({
      round,
      startedAt: this.pendingRoundStart || null,
      endedAt: new Date().toISOString(),
      replanReason: String(replanReason || "").slice(0, 500),
      planSignature,
      stages: stages.slice(0, 20).map((s) => ({
        stageId: s.stageId,
        name: String(s.name || "").slice(0, 80),
        disposition: s.disposition || "",
        reason: String(s.reason || "").slice(0, 300),
        attempts: Number(s.attempts) || 0,
        failedTasks: (s.failedTasks || []).slice(0, MAX_FAILED_TASKS_PER_ROUND).map((t) => ({
          taskId: t.taskId,
          errorCategory: t.errorCategory || "",
          error: String(t.error || "").slice(0, 300)
        }))
      })),
      fileChanges: fileChanges.slice(0, MAX_FILE_CHANGES_PER_ROUND).map((f) => ({
        path: f.path, added: Number(f.addedLines ?? f.added) || 0, removed: Number(f.removedLines ?? f.removed) || 0
      })),
      gates: normalizeGates(gates),
      criteria: criteria.map((c) => ({
        id: c.id, kind: c.kind, text: String(c.text || "").slice(0, 200),
        status: c.status, reason: String(c.reason || "").slice(0, 300),
        evidence: {
          ...(c.evidence?.command ? { command: c.evidence.command } : {}),
          ...(c.evidence?.exitCode != null ? { exitCode: c.evidence.exitCode } : {}),
          ...(c.evidence?.outputSnippet ? { outputSnippet: clampSnippet(c.evidence.outputSnippet) } : {}),
          ...(c.evidence?.path ? { path: c.evidence.path } : {})
        }
      })),
      subGoals: subGoals.map((s) => ({
        goalId: s.goalId, title: s.title, status: s.status, optional: s.optional === true,
        passed: s.passed, failed: s.failed, manual: s.manual
      })),
      progress: progress ? {
        madeProgress: progress.madeProgress === true,
        reason: String(progress.reason || "").slice(0, 300),
        signals: progress.signals || {}
      } : null,
      degradations,
      usage: usage ? { input: Number(usage.input) || 0, output: Number(usage.output) || 0 } : null,
      verdict
    })
    this.pendingRoundStart = null
    // max_rounds_kept：轮次记录只保留最近 N 条 —— blockers 聚合在裁剪前
    // 已经跨全部轮次算过，丢的是旧轮次的明细，不是受阻点的历史
    this._updateBlockers()
    if (this.data.rounds.length > this.maxRoundsKept) {
      this.data.rounds = this.data.rounds.slice(-this.maxRoundsKept)
    }
    await this.flush()
  }

  markRoundStart() {
    this.pendingRoundStart = new Date().toISOString()
  }

  async appendInteraction({ question = "", answer = "", action = "", source = "" }) {
    this.data.userInteractions.push({
      at: new Date().toISOString(),
      question: String(question).slice(0, 300),
      answer: String(answer).slice(0, 500),
      action, source
    })
    await this.flush()
  }

  async appendPlanDefect({ stageId = "", message = "", round = 0 }) {
    this.data.planDefects.push({ at: new Date().toISOString(), stageId, message: String(message).slice(0, 300), round })
    await this.flush()
  }

  noteErrorSignature(signature) {
    if (!signature) return 0
    this.data.errorSignatures[signature] = (this.data.errorSignatures[signature] || 0) + 1
    return this.data.errorSignatures[signature]
  }

  async setGoal(goal) {
    this.data.goal = goal ? {
      goalId: goal.goalId, objective: goal.objective, intent: goal.intent,
      criteria: goal.criteria, nonGoals: goal.nonGoals,
      subGoals: (goal.subGoals || []).map((s) => ({
        goalId: s.goalId, title: s.title, stageIds: s.stageIds, optional: s.optional, criteria: s.criteria
      })),
      revisions: goal.revisions || []
    } : null
    await this.flush()
  }

  async setFinal({ status, reply = "", reportPath = "" }) {
    this.data.finalStatus = status
    this.data.endedAt = new Date().toISOString()
    if (reportPath) this.data.reportPath = reportPath
    if (reply) this.data.finalReply = String(reply).slice(0, 1000)
    await this.flush()
  }

  /** 反复出现的受阻点：跨轮聚合，报告与重规划都吃它。 */
  _updateBlockers() {
    const seen = new Map()
    for (const round of this.data.rounds) {
      for (const criterion of round.criteria || []) {
        if (criterion.status !== "fail") continue
        const existing = seen.get(criterion.id)
        if (existing) {
          existing.lastSeenRound = round.round
          existing.attempts += 1
          existing.evidence = criterion.evidence
          existing.reason = criterion.reason
        } else {
          seen.set(criterion.id, {
            criterionId: criterion.id, kind: criterion.kind, text: criterion.text,
            reason: criterion.reason, evidence: criterion.evidence,
            firstSeenRound: round.round, lastSeenRound: round.round, attempts: 1
          })
        }
      }
    }
    this.data.blockers = [...seen.values()]
  }

  /**
   * 重规划输入：按「最近一轮 > 反复出现的 blocker > 更早轮次」的优先级裁剪
   * 到字符预算内。超预算时丢的是旧轮次，不是证据的质量。
   */
  snapshotForReplan({ maxChars = 6000 } = {}) {
    const parts = []
    const lastRound = this.data.rounds[this.data.rounds.length - 1]
    if (lastRound) {
      parts.push(`### 上一轮（第 ${lastRound.round} 轮）`)
      for (const stage of lastRound.stages) {
        if (!stage.failedTasks.length && stage.disposition !== "skip") continue
        parts.push(`- stage ${stage.stageId}: ${stage.disposition || "failed"} — ${stage.reason}`)
        for (const t of stage.failedTasks.slice(0, 5)) {
          parts.push(`  - task ${t.taskId} [${t.errorCategory}]: ${t.error}`)
        }
      }
      for (const c of lastRound.criteria.filter((c) => c.status === "fail")) {
        parts.push(`- 判据 ${c.id} 未过: ${c.reason}`)
        if (c.evidence?.outputSnippet) parts.push(`  输出: ${c.evidence.outputSnippet.slice(0, 400)}`)
      }
      if (lastRound.progress) parts.push(`- 进展判定: ${lastRound.progress.madeProgress ? "有" : "无"} — ${lastRound.progress.reason}`)
    }
    if (this.data.blockers.length) {
      parts.push("", "### 反复出现的受阻点")
      for (const b of this.data.blockers.slice(0, 8)) {
        parts.push(`- [${b.criterionId}] ${b.text} — 失败 ${b.attempts} 次（第 ${b.firstSeenRound}–${b.lastSeenRound} 轮）: ${b.reason}`)
      }
    }
    if (this.data.planDefects.length) {
      parts.push("", "### 计划缺陷")
      for (const d of this.data.planDefects.slice(-3)) parts.push(`- 第 ${d.round} 轮 ${d.stageId}: ${d.message}`)
    }
    for (const round of [...this.data.rounds].reverse().slice(1)) {
      const chunk = [`### 第 ${round.round} 轮（更早）`,
        ...round.stages.filter((s) => s.failedTasks.length).map((s) => `- ${s.stageId}: ${s.reason}`)]
      if (parts.join("\n").length + chunk.join("\n").length > maxChars) break
      parts.push("", ...chunk)
    }
    return parts.join("\n").slice(0, maxChars)
  }

  async flush() {
    await mkdir(path.dirname(this.path), { recursive: true }).catch(() => {})
    await writeJsonAtomic(this.path, this.data).catch(() => {})
  }
}

/** 打开（或续写）一个会话的台账。 */
export async function openLedger({ sessionId, cwd = process.cwd(), objective = "", goal = null, providerType = "", model = "", maxRoundsKept = 10 }) {
  const file = ledgerPath(sessionId, cwd)
  const existing = await readJson(file, null)
  const data = existing && existing.version === LEDGER_VERSION ? existing : {
    version: LEDGER_VERSION,
    sessionId,
    // resume 用：原 run 的渠道与模型 —— 不记这个，续跑会悄悄换到默认渠道
    providerType: String(providerType || ""),
    model: String(model || ""),
    objective: String(objective || "").slice(0, 500),
    startedAt: new Date().toISOString(),
    endedAt: null,
    finalStatus: null,
    goal: null,
    rounds: [],
    blockers: [],
    userInteractions: [],
    planDefects: [],
    errorSignatures: {}
  }
  // 续写已有台账时也补记渠道（老台账没有该字段）
  if (existing && providerType && !data.providerType) {
    data.providerType = String(providerType)
    data.model = String(model || "")
  }
  const ledger = new UltraLedger({ sessionId, cwd, data, maxRoundsKept })
  if (goal) {
    await ledger.setGoal(goal)   // setGoal 内部 flush
  } else if (!existing) {
    await ledger.flush()          // 新台账没有 goal 也要立即落盘，否则文件根本不存在
  }
  return ledger
}

/** 只读加载（`ultra report` 命令用）。不存在时返回 null。 */
export async function loadLedger(sessionId, cwd = process.cwd()) {
  const data = await readJson(ledgerPath(sessionId, cwd), null)
  if (!data || data.version !== LEDGER_VERSION) return null
  return new UltraLedger({ sessionId, cwd, data })
}
