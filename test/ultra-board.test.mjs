import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildBoardModel, renderUltraBoard, BOARD_COLUMNS } from "../src/ui/ultra-board.mjs"

const GOAL = {
  goalId: "g", objective: "two parts", intent: "code",
  criteria: [
    { id: "root_c1", kind: "gate_pass", text: "整体 build 通过", spec: { gate: "build" }, severity: "blocking" }
  ],
  subGoals: [
    { goalId: "s1", title: "core", optional: false, stageIds: ["stage_1"],
      criteria: [{ id: "s1_c1", kind: "file_exists", text: "core 在", spec: { path: "a" }, severity: "blocking" }] },
    { goalId: "s2", title: "ui", optional: true, stageIds: ["stage_2"],
      criteria: [{ id: "s2_c1", kind: "manual", text: "UI 观感", spec: { question: "看着对吗" }, severity: "blocking" }] }
  ]
}
const PLAN = {
  stages: [
    { stageId: "stage_1", name: "Core", tasks: [{ taskId: "t1", prompt: "write core", plannedFiles: ["a"] }] },
    { stageId: "stage_2", name: "UI", tasks: [
      { taskId: "t2", prompt: "write ui", plannedFiles: ["b"] },
      { taskId: "t3", prompt: "style ui", plannedFiles: ["c"] }
    ] }
  ]
}
const PROGRESS = {
  t1: { status: "completed" },
  t2: { status: "running" },
  t3: { status: "error", lastError: "TypeError: boom" }
}
const VERIFICATION = {
  results: [{ id: "root_c1", status: "fail", reason: "build failed with code 1", text: "整体 build 通过", severity: "blocking" }],
  subGoals: [
    { goalId: "s1", results: [{ id: "s1_c1", status: "pass", reason: "a 存在", text: "core 在", severity: "blocking" }] },
    { goalId: "s2", results: [{ id: "s2_c1", status: "pending_manual", reason: "看着对吗", text: "UI 观感", severity: "blocking" }] }
  ]
}

describe("buildBoardModel 五列归类", () => {
  const model = buildBoardModel({ goal: GOAL, stagePlan: PLAN, taskProgress: PROGRESS, verification: VERIFICATION })
  const byKey = Object.fromEntries(model.columns.map((c) => [c.key, c.cards]))

  it("列集合与顺序固定", () => {
    assert.deepEqual(model.columns.map((c) => c.key), BOARD_COLUMNS.map((c) => c.key))
  })

  it("task 卡片按状态归列，受阻卡片带原因", () => {
    assert.ok(byKey.done.some((c) => c.id === "t1"))
    assert.ok(byKey.doing.some((c) => c.id === "t2"))
    const failed = byKey.blocked.find((c) => c.id === "t3")
    assert.match(failed.detail, /TypeError/)
  })

  it("判据卡片：pass → 已达成，fail → 受阻，manual → 待验收", () => {
    assert.ok(byKey.done.some((c) => c.id === "s1_c1"))
    const rootFail = byKey.blocked.find((c) => c.id === "root_c1")
    assert.match(rootFail.detail, /build failed/)
    const manual = byKey.pending_check.find((c) => c.id === "s2_c1")
    assert.equal(manual.manual, true)
  })

  it("「待验收」收纳未核验的判据 —— 没核验就不冒充结果", () => {
    const unverified = buildBoardModel({ goal: GOAL, stagePlan: PLAN, taskProgress: PROGRESS, verification: null })
    const pending = unverified.columns.find((c) => c.key === "pending_check").cards
    assert.equal(pending.filter((c) => c.kind === "criterion").length, 3, "三条判据全部待验收")
    assert.ok(pending.every((c) => c.status === "unverified" || c.kind !== "criterion"))
  })

  it("卡片带子目标归属，summary 按子目标聚合", () => {
    assert.equal(byKey.done.find((c) => c.id === "t1").subGoal, "core")
    const coreSummary = model.summary.subGoals.find((s) => s.title === "core")
    assert.equal(coreSummary.done, 2, "core 的 task + 判据都已达成")
    const uiSummary = model.summary.subGoals.find((s) => s.title === "ui")
    assert.equal(uiSummary.optional, true)
  })

  it("进行中的任务可带实时详情", () => {
    const live = buildBoardModel({
      goal: GOAL, stagePlan: PLAN, taskProgress: PROGRESS, verification: VERIFICATION,
      liveTasks: { t2: { lastLine: "edit src/ui.mjs (+42)" } }
    })
    const doing = live.columns.find((c) => c.key === "doing").cards.find((c) => c.id === "t2")
    assert.match(doing.detail, /edit src\/ui\.mjs/)
  })
})

describe("renderUltraBoard", () => {
  const model = buildBoardModel({ goal: GOAL, stagePlan: PLAN, taskProgress: PROGRESS, verification: VERIFICATION })

  it("compact：每个子目标一行进度条 + 受阻计数，3-5 行", () => {
    const lines = renderUltraBoard(model, { compact: true })
    assert.ok(lines.length >= 2 && lines.length <= 5, `compact 形态 ${lines.length} 行`)
    const text = lines.join("\n")
    assert.match(text, /core/)
    assert.match(text, /ui/)
    assert.match(text, /受阻/)
    assert.match(text, /待验收/)
  })

  it("宽终端五列并排，窄终端降级为分组列表", () => {
    const wide = renderUltraBoard(model, { width: 140 })
    assert.match(wide[0], /待办.*进行中.*受阻.*待验收.*已达成/, "首行是列头")

    const narrow = renderUltraBoard(model, { width: 80 })
    const narrowText = narrow.join("\n")
    assert.match(narrowText, /受阻 \(/)
    assert.match(narrowText, /TypeError/, "窄形态保留受阻原因")
    assert.doesNotMatch(narrow[0] || "", /待办.*进行中.*受阻/, "窄终端不摆多列")
  })

  it("空模型不炸", () => {
    const empty = buildBoardModel({})
    assert.doesNotThrow(() => renderUltraBoard(empty, { width: 120 }))
    assert.doesNotThrow(() => renderUltraBoard(empty, { compact: true }))
  })
})
