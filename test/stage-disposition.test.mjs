import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { decideStageDisposition, hasDependents, DISPOSITION } from "../src/session/stage-disposition.mjs"

/**
 * 决策表逐行验证。核心断言只有一条：**任何情况下都不再出现 0.4.x 那个
 * 「放弃当前 stage 及所有后续 stage」的 break** —— ABORT 只留给用户停止
 * 与无法重规划的计划缺陷。
 */

describe("decideStageDisposition", () => {
  it("停止请求 → ABORT", () => {
    const d = decideStageDisposition({ stopped: true })
    assert.equal(d.disposition, DISPOSITION.ABORT)
  })

  it("计划缺陷 → 能重规划就 REPLAN，否则 ABORT", () => {
    assert.equal(decideStageDisposition({ planDefect: true, roundsLeft: true }).disposition, DISPOSITION.REPLAN)
    assert.equal(decideStageDisposition({ planDefect: true, roundsLeft: false }).disposition, DISPOSITION.ABORT)
    assert.equal(decideStageDisposition({ planDefect: true, roundsLeft: true, alreadyReplanned: true }).disposition, DISPOSITION.ABORT)
  })

  it("瞬时错误且额度未尽 → RETRY（保留 0.4.x 行为）", () => {
    const d = decideStageDisposition({ errorCategories: ["transient"], recoveries: 1, maxRecoveries: 3 })
    assert.equal(d.disposition, DISPOSITION.RETRY)
  })

  it("全为 PERMANENT 且无下游依赖 → 立即 SKIP，不烧 12 次退避", () => {
    // 0.4.x 在这里保证烧满 max_stage_attempts + 28 秒退避
    const d = decideStageDisposition({
      errorCategories: ["permanent", "unknown"], recoveries: 0, stageHasDependents: false
    })
    assert.equal(d.disposition, DISPOSITION.SKIP)
  })

  it("全为 PERMANENT 且有下游依赖 → REPLAN 换路线", () => {
    const d = decideStageDisposition({
      errorCategories: ["permanent"], stageHasDependents: true, roundsLeft: true
    })
    assert.equal(d.disposition, DISPOSITION.REPLAN)
    // 重规划用尽后退化为 SKIP，仍然不没收后续 stage
    const exhausted = decideStageDisposition({
      errorCategories: ["permanent"], stageHasDependents: true, roundsLeft: false, allowSkip: true
    })
    assert.equal(exhausted.disposition, DISPOSITION.SKIP)
  })

  it("重试额度用尽且可降级 → DEGRADE", () => {
    const d = decideStageDisposition({
      errorCategories: ["transient"], recoveries: 3, maxRecoveries: 3, canDegrade: true
    })
    assert.equal(d.disposition, DISPOSITION.DEGRADE)
  })

  it("累计尝试耗尽：defer → replan → skip 的退化链，永不 ABORT", () => {
    const base = { errorCategories: ["transient"], recoveries: 3, maxRecoveries: 3, canDegrade: false, attempts: 12, maxAttempts: 12 }

    const defer = decideStageDisposition({ ...base, stageHasDependents: false })
    assert.equal(defer.disposition, DISPOSITION.DEFER)

    const replan = decideStageDisposition({ ...base, alreadyDeferred: true, roundsLeft: true })
    assert.equal(replan.disposition, DISPOSITION.REPLAN)

    // 0.4.x 在这个位置 break 掉一切 —— 现在是 SKIP
    const skip = decideStageDisposition({ ...base, alreadyDeferred: true, roundsLeft: false })
    assert.equal(skip.disposition, DISPOSITION.SKIP)
    assert.match(skip.reason, /继续后续 stage/)
  })

  it("每个处置都带人话理由", () => {
    for (const args of [
      { stopped: true },
      { planDefect: true, roundsLeft: true },
      { errorCategories: ["permanent"] },
      { errorCategories: ["transient"], recoveries: 0 }
    ]) {
      const d = decideStageDisposition(args)
      assert.ok(d.reason.length > 4, `${d.disposition} 缺理由`)
    }
  })
})

describe("hasDependents", () => {
  const plan = {
    stages: [
      { stageId: "s1", tasks: [{ taskId: "t1", plannedFiles: ["src/core.mjs"], prompt: "写 core" }] },
      { stageId: "s2", tasks: [{ taskId: "t2", plannedFiles: ["src/app.mjs"], prompt: "在 app 里 import src/core.mjs" }] },
      { stageId: "s3", tasks: [{ taskId: "t3", plannedFiles: ["docs/x.md"], prompt: "写文档" }] }
    ]
  }

  it("prompt 引用 / 显式 dependsOn / 文件重叠都算依赖", () => {
    assert.equal(hasDependents(plan, 0), true, "s2 的 prompt 提到了 s1 的产物")
    assert.equal(hasDependents(plan, 1), false)
    assert.equal(hasDependents(plan, 2), false, "最后一个 stage 没有下游")

    const explicit = {
      stages: [
        { stageId: "s1", tasks: [{ taskId: "t1", plannedFiles: ["a.mjs"], prompt: "a" }] },
        { stageId: "s2", tasks: [{ taskId: "t2", plannedFiles: ["b.mjs"], prompt: "b", dependsOn: ["t1"] }] }
      ]
    }
    assert.equal(hasDependents(explicit, 0), true)
  })

  it("越界与空计划返回 false", () => {
    assert.equal(hasDependents(plan, 9), false)
    assert.equal(hasDependents(null, 0), false)
  })
})
