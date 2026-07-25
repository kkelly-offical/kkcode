import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { openLedger, loadLedger, ledgerPath } from "../src/session/ultra-ledger.mjs"
import { buildBlockedReport, renderBlockedReportText, renderBlockedReportMarkdown } from "../src/session/blocked-report.mjs"
import { resolveUltraStatus, exitCodeForUltraStatus, sessionStatusForUltraStatus, ULTRA_STATUS } from "../src/session/ultra-status.mjs"
import { normalizeGoal, freezeGoal } from "../src/session/goal-model.mjs"

const tmp = await mkdtemp(path.join(os.tmpdir(), "kkcode-ledger-"))
test.after(async () => { await rm(tmp, { recursive: true, force: true }).catch(() => {}) })

function sampleGoal() {
  const { goal } = normalizeGoal({
    objective: "build auth", criteria: ["npm test passes", "src/auth.mjs"]
  }, { objective: "build auth" })
  return freezeGoal(goal)
}

async function ledgerWithFailingRound() {
  const goal = sampleGoal()
  const ledger = await openLedger({ sessionId: `led_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, cwd: tmp, objective: "build auth", goal })
  const [cmd, file] = goal.criteria
  await ledger.appendRound({
    round: 1, planSignature: "abc123",
    stages: [{ stageId: "stage_1", name: "Auth", disposition: "retry", reason: "2 tasks failed", attempts: 3,
      failedTasks: [{ taskId: "t1", errorCategory: "logic", error: "TypeError: x is not a function" }] }],
    fileChanges: [{ path: "src/auth.mjs", addedLines: 120, removedLines: 4 }],
    gates: { build: { status: "fail", reason: "build failed with code 1", output: "src/auth.mjs:3 SyntaxError | at compile" } },
    criteria: [
      { id: cmd.id, kind: cmd.kind, text: cmd.text, status: "fail", reason: "npm test 退出码 1",
        evidence: { command: "npm test", exitCode: 1, outputSnippet: "2 failing | AssertionError: expected 1" } },
      { id: file.id, kind: file.kind, text: file.text, status: "pass", reason: "src/auth.mjs 存在（3072 字节）" }
    ],
    progress: { madeProgress: true, reason: "新增文件 src/auth.mjs", signals: {} },
    usage: { input: 1000, output: 500 }
  })
  return { ledger, goal, cmd, file }
}

describe("ledger 落盘与读回", () => {
  it("写入 → loadLedger 读回同一份数据", async () => {
    const { ledger } = await ledgerWithFailingRound()
    const loaded = await loadLedger(ledger.sessionId, tmp)
    assert.ok(loaded)
    assert.equal(loaded.data.rounds.length, 1)
    assert.equal(loaded.data.rounds[0].criteria.length, 2)
    assert.equal(loaded.data.objective, "build auth")
    assert.ok(loaded.data.goal, "goal 必须随台账落盘")
  })

  it("gate 与判据的 output snippet 原样保留", async () => {
    const { ledger } = await ledgerWithFailingRound()
    const raw = JSON.parse(await readFile(ledgerPath(ledger.sessionId, tmp), "utf8"))
    assert.match(raw.rounds[0].gates.build.outputSnippet, /SyntaxError/)
    assert.match(raw.rounds[0].criteria[0].evidence.outputSnippet, /AssertionError/)
  })

  it("反复失败的判据聚合进 blockers", async () => {
    const { ledger, cmd } = await ledgerWithFailingRound()
    await ledger.appendRound({
      round: 2,
      stages: [],
      criteria: [{ id: cmd.id, kind: cmd.kind, text: cmd.text, status: "fail", reason: "npm test 仍然退出码 1", evidence: {} }]
    })
    const blocker = ledger.data.blockers.find((b) => b.criterionId === cmd.id)
    assert.equal(blocker.attempts, 2)
    assert.deepEqual([blocker.firstSeenRound, blocker.lastSeenRound], [1, 2])
  })

  it("裁剪上限：fileChanges ≤200，snippet ≤2000 字符", async () => {
    const ledger = await openLedger({ sessionId: `led_cap_${Date.now()}`, cwd: tmp, objective: "x" })
    await ledger.appendRound({
      round: 1, stages: [],
      fileChanges: Array.from({ length: 400 }, (_, i) => ({ path: `f${i}.mjs`, addedLines: 1, removedLines: 0 })),
      gates: { build: { status: "fail", reason: "r", output: "x".repeat(9000) } },
      criteria: []
    })
    assert.equal(ledger.data.rounds[0].fileChanges.length, 200)
    assert.ok(ledger.data.rounds[0].gates.build.outputSnippet.length <= 2000)
  })

  it("snapshotForReplan 有字符预算，优先保住最近一轮与 blockers", async () => {
    const { ledger } = await ledgerWithFailingRound()
    const snapshot = ledger.snapshotForReplan({ maxChars: 1200 })
    assert.ok(snapshot.length <= 1200)
    assert.match(snapshot, /上一轮/)
    assert.match(snapshot, /TypeError/)
    assert.match(snapshot, /AssertionError/, "判据失败的证据必须在重规划输入里")
  })

  it("errorSignature 跨轮计数", async () => {
    const ledger = await openLedger({ sessionId: `led_sig_${Date.now()}`, cwd: tmp, objective: "x" })
    assert.equal(ledger.noteErrorSignature("sig_a"), 1)
    assert.equal(ledger.noteErrorSignature("sig_a"), 2)
    assert.equal(ledger.noteErrorSignature("sig_b"), 1)
  })
})

describe("blocked-report", () => {
  it("报告只读 ledger，包含 12 行证据与尝试次数", async () => {
    const { ledger, cmd } = await ledgerWithFailingRound()
    await ledger.appendRound({
      round: 2, stages: [],
      criteria: [{ id: cmd.id, kind: cmd.kind, text: cmd.text, status: "fail", reason: "仍失败",
        evidence: { command: "npm test", exitCode: 1, outputSnippet: "still 2 failing" } }]
    })
    await ledger.setFinal({ status: "blocked" })

    const report = buildBlockedReport(ledger)
    assert.equal(report.status, "blocked")
    assert.equal(report.roundsUsed, 2)
    const blockedItem = report.blocked.find((b) => b.id === cmd.id)
    assert.equal(blockedItem.attempts, 2)
    assert.match(blockedItem.evidence.outputSnippet, /still 2 failing/)

    const text = renderBlockedReportText(report).join("\n")
    assert.match(text, /未达成/)
    assert.match(text, /尝试 2 次/)
    assert.match(text, /still 2 failing/, "文本渲染必须带证据")
    assert.match(text, /kkcode ultra resume --session/)

    const markdown = renderBlockedReportMarkdown(report)
    assert.match(markdown, /## 验收判据/)
    assert.match(markdown, /still 2 failing/, "markdown 渲染必须带证据")
    assert.match(markdown, /## 每轮尝试/)
  })

  it("LLM 摘要缺失时报告仍完整 —— 模板版是底线", async () => {
    const { ledger } = await ledgerWithFailingRound()
    const report = buildBlockedReport(ledger, { status: "blocked", llmSummary: null })
    assert.equal(report.headline, "")
    assert.deepEqual(report.nextSteps, [])
    const text = renderBlockedReportText(report).join("\n")
    assert.match(text, /未达成/)
    assert.doesNotMatch(text, /关键判断/, "没有摘要就不渲染空段落")
  })

  it("被删除的 blocking 判据强制出现在报告里", async () => {
    const goal = sampleGoal()
    const ledger = await openLedger({ sessionId: `led_drop_${Date.now()}`, cwd: tmp, objective: "x", goal })
    ledger.data.goal.revisions = [{ round: 2, reason: "范围调整", added: [], removed: [{ id: "c1", text: "性能不退化", reason: "本期不做性能" }] }]
    await ledger.appendRound({ round: 1, stages: [], criteria: [] })
    const report = buildBlockedReport(ledger, { status: "partial" })
    assert.equal(report.criteriaChanged.length, 1)
    const text = renderBlockedReportText(report).join("\n")
    assert.match(text, /验收标准变更/)
    assert.match(text, /性能不退化/)
    assert.match(text, /本期不做性能/)
  })
})

describe("resolveUltraStatus", () => {
  const verified = (status, extra = {}) => ({ status, passed: 1, failed: 0, unknown: 0, manual: 0, ...extra })

  it("completed 只能来自验收判据 + 门禁，不来自完成标记", () => {
    assert.equal(resolveUltraStatus({
      verification: verified("met"), usabilityGatesPassed: true
    }), ULTRA_STATUS.COMPLETED)

    // 模型说 [TASK_COMPLETE] 但判据未过 —— 自我声明不是证据
    assert.equal(resolveUltraStatus({
      verification: verified("unmet", { passed: 0 }), usabilityGatesPassed: true, completionMarkerSeen: true, hadOutput: true
    }), ULTRA_STATUS.BLOCKED)

    // 判据 met 但门禁没过也不算
    assert.equal(resolveUltraStatus({
      verification: verified("met"), usabilityGatesPassed: false, hadOutput: true
    }), ULTRA_STATUS.PARTIAL)
  })

  it("状态优先级：fatal > 停止 > 耗尽 > 判据", () => {
    assert.equal(resolveUltraStatus({ fatalError: new Error("x"), verification: verified("met"), usabilityGatesPassed: true }), ULTRA_STATUS.FATAL)
    assert.equal(resolveUltraStatus({ stopped: true, verification: verified("met") }), ULTRA_STATUS.USER_STOPPED)
    assert.equal(resolveUltraStatus({ exhausted: "budget", verification: verified("met") }), ULTRA_STATUS.BUDGET_EXHAUSTED)
    assert.equal(resolveUltraStatus({ exhausted: "deadline" }), ULTRA_STATUS.DEADLINE_EXHAUSTED)
  })

  it("blocked_manual 与 partial", () => {
    assert.equal(resolveUltraStatus({ verification: verified("blocked_manual", { manual: 1 }) }), ULTRA_STATUS.BLOCKED_MANUAL)
    assert.equal(resolveUltraStatus({ verification: verified("unmet"), hadOutput: true }), ULTRA_STATUS.PARTIAL, "有 pass 有产出 → partial")
    assert.equal(resolveUltraStatus({ verification: verified("unmet", { passed: 0 }), hadOutput: true }), ULTRA_STATUS.BLOCKED)
    // 「交付已完成部分」的前提是有已完成的部分 —— 零达成时 deliver_partial
    // 也不能把 blocked 抬成 partial，否则 CI 里彻底停滞的运行以退出码 0 静默通过
    assert.equal(resolveUltraStatus({ userDecision: "deliver_partial", verification: verified("unmet") }), ULTRA_STATUS.PARTIAL)
    assert.equal(resolveUltraStatus({ userDecision: "deliver_partial", verification: verified("unmet", { passed: 0 }) }), ULTRA_STATUS.BLOCKED)
  })

  it("goal_mode 关闭时退回 0.4.x 二值语义", () => {
    assert.equal(resolveUltraStatus({ verification: null, usabilityGatesPassed: true, completionMarkerSeen: true }), ULTRA_STATUS.COMPLETED)
    assert.equal(resolveUltraStatus({ verification: null, usabilityGatesPassed: false }), ULTRA_STATUS.BLOCKED)
  })

  it("退出码与会话状态映射", () => {
    assert.equal(exitCodeForUltraStatus(ULTRA_STATUS.COMPLETED), 0)
    assert.equal(exitCodeForUltraStatus(ULTRA_STATUS.BLOCKED), 2)
    assert.equal(exitCodeForUltraStatus(ULTRA_STATUS.BLOCKED_MANUAL), 3)
    assert.equal(exitCodeForUltraStatus(ULTRA_STATUS.BUDGET_EXHAUSTED), 4)
    assert.equal(exitCodeForUltraStatus(ULTRA_STATUS.FATAL), 1)

    assert.equal(sessionStatusForUltraStatus(ULTRA_STATUS.COMPLETED), "completed")
    assert.equal(sessionStatusForUltraStatus(ULTRA_STATUS.FATAL), "failed")
    // failed 只留给 fatal —— 门禁没过说明活没干完，不是会话坏了
    assert.equal(sessionStatusForUltraStatus(ULTRA_STATUS.BLOCKED), "active")
    assert.equal(sessionStatusForUltraStatus(ULTRA_STATUS.PARTIAL), "active")
  })
})
