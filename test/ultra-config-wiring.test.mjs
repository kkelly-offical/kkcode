import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, access } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * 0.5.3：把 0.5.0 冲刺里引入却没接线的配置全部接上（A 组），
 * 外加三个行为缺陷（B 组）。整个 0.5.0 的主题之一就是清算死配置 ——
 * 自己新造的死配置必须在同一个大版本里偿清。
 */

const tmpHome = await mkdtemp(path.join(os.tmpdir(), "kkcode-wiring-home-"))
const tmpProject = await mkdtemp(path.join(os.tmpdir(), "kkcode-wiring-proj-"))
process.env.KKCODE_HOME = tmpHome
const originalCwd = process.cwd()
process.chdir(tmpProject)

const { registerProvider } = await import("../src/provider/router.mjs")
const { runHybridLongAgent } = await import("../src/session/longagent-hybrid.mjs")
const { openLedger, loadLedger, ledgerPath } = await import("../src/session/ultra-ledger.mjs")
const { verifyCriterion } = await import("../src/session/goal-verifier.mjs")
const { requestFast } = await import("../src/provider/fast-model.mjs")
const { createScriptedProvider, stagePlanFence, ultraConfig } = await import("./helpers/ultra-harness.mjs")
const { installBackgroundMock, restoreBackgroundMock } = await import("./helpers/background-mock.mjs")

test.after(async () => {
  restoreBackgroundMock()
  process.chdir(originalCwd)
  await rm(tmpHome, { recursive: true, force: true }).catch(() => {})
  await rm(tmpProject, { recursive: true, force: true }).catch(() => {})
})

describe("A1 allow_shell", () => {
  const criterion = { id: "c", kind: "command_exit", text: "x", severity: "blocking", spec: { command: "node", args: ["-v"], expect: 0 } }

  it("默认 shell:false，显式打开才传 shell:true", async () => {
    const seen = []
    const deps = { runGateCommand: async (args) => { seen.push(args); return { ok: true, code: 0, stdout: "", stderr: "" } } }

    await verifyCriterion(criterion, { config: {}, deps })
    assert.equal(seen[0].shell, false, "默认绝不过 shell")

    await verifyCriterion(criterion, {
      config: { agent: { longagent: { ultra: { criteria: { allow_shell: true } } } } }, deps
    })
    assert.equal(seen[1].shell, true, "显式配置后才允许 shell 解释")
  })
})

describe("A4 ledger.max_rounds_kept + B1 渠道记录", () => {
  it("轮次只保留最近 N 条，blockers 聚合不受裁剪影响", async () => {
    const ledger = await openLedger({ sessionId: `wire_cap_${Date.now()}`, cwd: tmpProject, objective: "x", maxRoundsKept: 3 })
    for (let i = 1; i <= 6; i++) {
      await ledger.appendRound({
        round: i, stages: [],
        criteria: [{ id: "c1", kind: "file_exists", text: "t", status: "fail", reason: `r${i}`, evidence: {} }]
      })
    }
    assert.equal(ledger.data.rounds.length, 3, "只留最近 3 轮")
    assert.deepEqual(ledger.data.rounds.map((r) => r.round), [4, 5, 6])
    const blocker = ledger.data.blockers.find((b) => b.criterionId === "c1")
    assert.ok(blocker.attempts >= 3, "受阻点跨轮聚合仍然有效")
  })

  it("台账记录原 run 的渠道与模型 —— resume 不再悄悄换渠道", async () => {
    const sid = `wire_prov_${Date.now()}`
    await openLedger({ sessionId: sid, cwd: tmpProject, objective: "x", providerType: "aliyun", model: "qwen3.7-plus" })
    const loaded = await loadLedger(sid, tmpProject)
    assert.equal(loaded.data.providerType, "aliyun")
    assert.equal(loaded.data.model, "qwen3.7-plus")
  })
})

describe("A5 requestFast 的 model 覆盖", () => {
  it("覆盖值优先于 models.fast，且支持 provider/model 限定", async () => {
    const configState = {
      config: {
        models: { fast: "fast-default" },
        provider: { default: "kimi", kimi: {}, aliyun: {} }
      }
    }
    const seen = []
    const deps = { requestProvider: async (args) => { seen.push(args); return { text: "ok" } } }

    await requestFast({ configState, prompt: "x", model: "aliyun/qwen-flash", deps })
    assert.equal(seen[0].providerType, "aliyun")
    assert.equal(seen[0].model, "qwen-flash")

    await requestFast({ configState, prompt: "x", deps })
    assert.equal(seen[1].model, "fast-default", "不传覆盖时仍走 models.fast")
  })
})

describe("A2/A3 + B2 端到端（harness）", () => {
  const PLAN = {
    planId: "pw", objective: "wire",
    goal: {
      objective: "wire", intent: "code",
      criteria: [{ kind: "file_exists", text: "产物在", spec: { path: "src/wire.mjs" } }]
    },
    stages: [{ stageId: "s1", name: "W", tasks: [{ taskId: "t1", prompt: "write wire file", plannedFiles: ["src/wire.mjs"], acceptance: ["src/wire.mjs"] }] }]
  }

  function register() {
    registerProvider("mock_wiring", createScriptedProvider([
      { stage: 1, reply: "ok" },
      { stage: 2, reply: stagePlanFence(PLAN) },
      { stage: 4, reply: "pass\n[STAGE 4/4: DEBUGGING - COMPLETE]\n[TASK_COMPLETE]" }
    ], { fallback: "acknowledged" }))
  }

  it("ledger.enabled:false → 不落盘台账、无报告，运行照常完成", async () => {
    register()
    installBackgroundMock({ reply: "[TASK_COMPLETE] done" })
    try {
      const result = await runHybridLongAgent({
        prompt: "wire it up", model: "mock-model", providerType: "mock_wiring",
        sessionId: "wire_noledger",
        configState: ultraConfig({ providerName: "mock_wiring" }, { ultra: { ledger: { enabled: false } } })
      })
      assert.equal(result.status, "completed")
      assert.equal(result.ledgerPath, null)
      assert.equal(result.blockedReport, null)
      await assert.rejects(access(ledgerPath("wire_noledger", tmpProject)), "台账不该落盘")
    } finally { restoreBackgroundMock() }
  })

  it("report.write_markdown:false → 报告对象仍返回，但 report.md 不落盘", async () => {
    // 独立的文件路径 —— 上一个用例已写出 src/wire.mjs，同一路径会让判据直接通过
    const PLAN2 = JSON.parse(JSON.stringify(PLAN))
    PLAN2.goal.criteria[0].spec.path = "src/wire-nomd.mjs"
    PLAN2.stages[0].tasks[0].plannedFiles = ["src/wire-nomd.mjs"]
    registerProvider("mock_wiring", createScriptedProvider([
      { stage: 1, reply: "ok" },
      { stage: 2, reply: stagePlanFence(PLAN2) },
      { stage: 4, reply: "pass\n[STAGE 4/4: DEBUGGING - COMPLETE]\n[TASK_COMPLETE]" }
    ], { fallback: "acknowledged" }))
    installBackgroundMock({ reply: "done", completeFiles: true, writeFiles: false })  // 文件不写 → 判据失败 → 有受阻报告
    try {
      const result = await runHybridLongAgent({
        prompt: "wire it up", model: "mock-model", providerType: "mock_wiring",
        sessionId: "wire_nomd",
        configState: ultraConfig({ providerName: "mock_wiring" }, {
          ultra: { max_rounds: 1, report: { write_markdown: false, llm_summary: false } }
        })
      })
      assert.notEqual(result.status, "completed")
      assert.ok(result.blockedReport, "结构化报告不受 write_markdown 影响")
      assert.equal(result.reportPath, null, "report.md 不该落盘")
    } finally { restoreBackgroundMock() }
  })

  it("B2：manual-only 目标 + 未完成的工作 → 先干活，而不是第一轮就 blocked_manual 交卷", async () => {
    // 目标只有 manual 判据（兜底形态），但任务第一轮失败、第二轮才成 ——
    // 0.5.2 之前第一轮核验 blocked_manual 直接 break，第二轮永远不会发生
    const MANUAL_PLAN = {
      planId: "pm", objective: "manual only",
      goal: {
        objective: "manual only", intent: "code",
        criteria: [{ kind: "manual", text: "请人工确认", spec: { question: "确认?" } }]
      },
      stages: [{ stageId: "s1", name: "M", tasks: [{ taskId: "t_m", prompt: "write MODE_M file", plannedFiles: ["src/m.mjs"], acceptance: ["src/m.mjs"] }] }]
    }
    registerProvider("mock_wiring", createScriptedProvider([
      { stage: 1, reply: "ok" },
      { stage: 2, reply: stagePlanFence(MANUAL_PLAN) },
      { stage: 4, reply: "pass\n[STAGE 4/4: DEBUGGING - COMPLETE]\n[TASK_COMPLETE]" }
    ], { fallback: "acknowledged" }))
    let calls = 0
    installBackgroundMock({
      writeFiles: false,   // mock 不自动写 —— 由 behavior 控制第几轮才有真产物
      behavior: async (payload) => {
        if (!/MODE_M/.test(payload?.prompt || "")) return null
        calls += 1
        // 第一轮：声称完成但不写文件（vacuous complete）。0.5.2 之前
        // blocked_manual 会在这里直接交卷；现在「completed 但产物缺失」
        // 算没做完 → 进入第二轮 → 降级重做 → 真写出文件。
        if (calls === 1) return null
        const { mkdir: mk, writeFile: wf } = await import("node:fs/promises")
        const target = path.resolve(process.cwd(), "src/m.mjs")
        await mk(path.dirname(target), { recursive: true })
        await wf(target, "export const m = 1\n", "utf8")
        return null
      }
    })
    try {
      const result = await runHybridLongAgent({
        prompt: "manual only goal", model: "mock-model", providerType: "mock_wiring",
        sessionId: "wire_manual",
        configState: ultraConfig({ providerName: "mock_wiring" })
      })
      // 终局仍然如实报 blocked_manual（人没点头），但可做的工作已经做完
      assert.equal(result.status, "blocked_manual")
      assert.equal(result.taskProgress.t_m.status, "completed", "可执行的工作必须先做完")
      const { access: acc } = await import("node:fs/promises")
      await acc(path.resolve(tmpProject, "src/m.mjs"))
    } finally { restoreBackgroundMock() }
  })
})
