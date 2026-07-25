import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { errorSignature, snapshotRound, diffSnapshots } from "../src/session/progress-signal.mjs"

describe("errorSignature", () => {
  it("路径 / 行号 / hex / 时间戳抹平后相同错误同签名", () => {
    const a = errorSignature("TypeError: x is not a function at /home/u/proj/src/a.mjs:31:5")
    const b = errorSignature("TypeError: x is not a function at /tmp/other/src/b.mjs:99:12")
    assert.equal(a, b, "同一错误在不同路径/行号下必须同签名")

    const c = errorSignature("ReferenceError: y is not defined at src/a.mjs:31")
    assert.notEqual(a, c, "不同错误必须不同签名")
    assert.equal(errorSignature(""), "")
  })
})

function snap(over = {}) {
  return {
    criteria: {}, gates: {}, files: {}, errorSignatures: [],
    tasksCompleted: 0, planSig: "sig1", maxStageIndexReached: 0, ...over
  }
}

describe("diffSnapshots 的进展判定", () => {
  it("首轮：有产出即进展", () => {
    assert.equal(diffSnapshots(null, snap({ tasksCompleted: 1 })).madeProgress, true)
    assert.equal(diffSnapshots(null, snap()).madeProgress, false)
  })

  it("判据 fail→pass 是最强信号", () => {
    const d = diffSnapshots(
      snap({ criteria: { c1: "fail", c2: "pass" } }),
      snap({ criteria: { c1: "pass", c2: "pass" } })
    )
    assert.equal(d.madeProgress, true)
    assert.deepEqual(d.signals.criteriaAdvanced, ["c1"])
  })

  it("负进展 pass→fail 单独报出", () => {
    const d = diffSnapshots(
      snap({ criteria: { c1: "pass" } }),
      snap({ criteria: { c1: "fail" } })
    )
    assert.deepEqual(d.signals.criteriaRegressed, ["c1"])
    assert.equal(d.madeProgress, false)
  })

  it("改了文件但错误一字不差 → 不算进展（原地打转的最常见形态）", () => {
    const d = diffSnapshots(
      snap({ files: { "a.mjs": { added: 10, removed: 0 } }, errorSignatures: ["sig_x"] }),
      snap({ files: { "a.mjs": { added: 25, removed: 3 } }, errorSignatures: ["sig_x"] })
    )
    assert.equal(d.madeProgress, false)
    assert.match(d.reason, /一字不差/)
  })

  it("错误变了 → 算进展", () => {
    const d = diffSnapshots(
      snap({ errorSignatures: ["sig_a"] }),
      snap({ errorSignatures: ["sig_b"] })
    )
    assert.equal(d.madeProgress, true)
    assert.match(d.reason, /错误变了/)
  })

  it("计划措辞变了但签名没变 → 无进展理由里点名", () => {
    const d = diffSnapshots(
      snap({ planSig: "same" }),
      snap({ planSig: "same" })
    )
    assert.equal(d.madeProgress, false)
    assert.match(d.reason, /计划结构与上一轮相同/)
  })

  it("完成任务数与 stage 推进都算进展", () => {
    assert.equal(diffSnapshots(snap(), snap({ tasksCompleted: 2 })).madeProgress, true)
    assert.equal(diffSnapshots(snap(), snap({ maxStageIndexReached: 1 })).madeProgress, true)
  })

  it("门禁 fail→pass 算进展", () => {
    const d = diffSnapshots(
      snap({ gates: { build: "fail" } }),
      snap({ gates: { build: "pass" } })
    )
    assert.equal(d.madeProgress, true)
  })
})

describe("snapshotRound", () => {
  it("从核验结果、门禁与任务状态采集", () => {
    const s = snapshotRound({
      verification: {
        results: [{ id: "c1", status: "pass" }],
        subGoals: [{ results: [{ id: "s1_c1", status: "fail" }] }]
      },
      gateResult: { gates: { build: { status: "pass" }, test: { status: "fail" } } },
      taskProgress: {
        t1: { status: "completed" },
        t2: { status: "error", lastError: "TypeError at /x/y.mjs:3" }
      },
      fileChanges: [
        { path: "a.mjs", addedLines: 5, removedLines: 1 },
        { path: "a.mjs", addedLines: 3, removedLines: 0 }
      ],
      planSig: "abc",
      maxStageIndexReached: 2
    })
    assert.equal(s.criteria.c1, "pass")
    assert.equal(s.criteria.s1_c1, "fail", "子目标的判据也要进快照")
    assert.equal(s.gates.build, "pass")
    assert.deepEqual(s.files["a.mjs"], { added: 8, removed: 1 }, "同文件多次变更累计")
    assert.equal(s.tasksCompleted, 1)
    assert.equal(s.errorSignatures.length, 1)
  })
})
