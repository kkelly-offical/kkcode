import test, { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  parseCriterionString, normalizeCriterionObject, normalizeAcceptance,
  classifyGoalIntent, intentProfile, normalizeGoal, freezeGoal, reviseGoal,
  planSignature, splitArgv, resetCriterionCounter
} from "../src/session/goal-model.mjs"

beforeEach(() => resetCriterionCounter())

describe("parseCriterionString 启发式", () => {
  it("命令 → command_exit / test_pass", () => {
    const check = parseCriterionString("node --check src/foo.mjs passes")
    assert.equal(check.kind, "command_exit")
    assert.equal(check.spec.command, "node")
    assert.deepEqual(check.spec.args, ["--check", "src/foo.mjs"])

    const testRun = parseCriterionString("npm test -- --grep auth passes")
    assert.equal(testRun.kind, "test_pass")

    const pytest = parseCriterionString("pytest tests/ 通过")
    assert.equal(pytest.kind, "test_pass")
  })

  it("文件路径 → file_exists", () => {
    assert.equal(parseCriterionString("src/session/goal-model.mjs").kind, "file_exists")
    assert.equal(parseCriterionString("file docs/report.md exists").kind, "file_exists")
    assert.equal(parseCriterionString("文件 src/a.mjs 存在").spec.path, "src/a.mjs")
  })

  it("exports / contains → content_match", () => {
    const exp = parseCriterionString("exports verifyGoal from src/session/goal-verifier.mjs")
    assert.equal(exp.kind, "content_match")
    assert.match("export function verifyGoal", new RegExp(exp.spec.pattern))
    assert.match("export async function verifyGoal", new RegExp(exp.spec.pattern))

    const contains = parseCriterionString("README.md contains 0.5.0")
    assert.equal(contains.kind, "content_match")
    assert.equal(contains.spec.path, "README.md")
  })

  it("build passes → gate_pass", () => {
    assert.deepEqual(parseCriterionString("build passes").spec, { gate: "build" })
    assert.equal(parseCriterionString("test 通过").kind, "gate_pass")
  })

  it("无法机器化的散文一律落到 manual —— 这是安全属性", () => {
    // defaultStagePlan 的这句主观判据在 0.4.x 里等于自动通过；
    // 现在它会把目标推进 blocked_manual，逼出一次用户确认
    for (const prose of [
      "Task objective is fully usable",
      "code is clean and maintainable",
      "UI 上能看到进度",
      "works as expected"
    ]) {
      const criterion = parseCriterionString(prose)
      assert.equal(criterion.kind, "manual", `"${prose}" 必须落到 manual`)
      assert.equal(criterion.spec.question, prose)
    }
  })

  it("splitArgv 处理引号", () => {
    assert.deepEqual(splitArgv(`node -e "console.log(1)"`), ["node", "-e", "console.log(1)"])
  })
})

describe("normalizeCriterionObject", () => {
  it("接受结构化判据并校验关键字段", () => {
    const ok = normalizeCriterionObject({ kind: "file_exists", spec: { path: "a.md", minBytes: 100 } })
    assert.equal(ok.spec.minBytes, 100)
    assert.equal(normalizeCriterionObject({ kind: "file_exists", spec: {} }), null, "缺 path 即无效")
    assert.equal(normalizeCriterionObject({ kind: "content_match", spec: { path: "a" } }), null, "缺 pattern 即无效")
  })

  it("kind 不认识时按 text 重新走启发式，绝不静默丢弃", () => {
    const fallback = normalizeCriterionObject({ kind: "vibe_check", text: "npm test passes" })
    assert.equal(fallback.kind, "test_pass")
    const manual = normalizeCriterionObject({ kind: "vibe_check", text: "looks good" })
    assert.equal(manual.kind, "manual")
  })

  it("command 的 run 字符串形态被拆成 argv", () => {
    const criterion = normalizeCriterionObject({ kind: "command_exit", spec: { run: "npm run build" } })
    assert.equal(criterion.spec.command, "npm")
    assert.deepEqual(criterion.spec.args, ["run", "build"])
  })
})

describe("normalizeAcceptance", () => {
  it("字符串与对象混填，0.4.x 的纯字符串计划照常工作", () => {
    const list = normalizeAcceptance([
      "node --check src/a.mjs",
      { kind: "manual", spec: { question: "确认 UI" } },
      "src/a.mjs"
    ], { owner: "t1" })
    assert.deepEqual(list.map((c) => c.kind), ["command_exit", "manual", "file_exists"])
    assert.ok(list.every((c) => c.owner === "t1"))
  })

  it("非数组返回空", () => {
    assert.deepEqual(normalizeAcceptance(null), [])
    assert.deepEqual(normalizeAcceptance("npm test"), [])
  })
})

describe("classifyGoalIntent 与 profile", () => {
  it("四类目标各归其位", () => {
    assert.equal(classifyGoalIntent("修复登录接口的 500 报错"), "code")
    assert.equal(classifyGoalIntent("调研本仓库的 Ultra 编排现状"), "research")
    assert.equal(classifyGoalIntent("给项目写一份部署指南文档"), "docs")
    assert.equal(classifyGoalIntent("配置 CI 并部署到 k8s"), "ops")
    assert.equal(classifyGoalIntent("实现 X 功能并写好 README 文档"), "mixed")
  })

  it("research/docs/ops 不再要求 plannedFiles —— 非编码目标原地打转的根因", () => {
    assert.equal(intentProfile("research").requirePlannedFiles, false)
    assert.equal(intentProfile("research").scaffold, false)
    assert.equal(intentProfile("docs").buildTestGates, false)
    assert.equal(intentProfile("code").requirePlannedFiles, true)
    assert.equal(intentProfile("code").scaffold, true)
  })
})

describe("normalizeGoal 目标树", () => {
  const base = {
    objective: "build the thing",
    criteria: ["npm test passes"],
    subGoals: [
      { title: "core", criteria: ["src/core.mjs"], stageIds: ["stage_1"] },
      { title: "wire", criteria: ["src/wire.mjs"], stageIds: ["stage_2"], optional: true }
    ]
  }

  it("正常形态归一化无错误", () => {
    const { goal, errors } = normalizeGoal(base, { objective: "build the thing", stageIds: ["stage_1", "stage_2"] })
    assert.deepEqual(errors, [])
    assert.equal(goal.subGoals.length, 2)
    assert.equal(goal.subGoals[1].optional, true)
    assert.equal(goal.intent, "code")
  })

  it("stage 归属必须唯一", () => {
    const dup = JSON.parse(JSON.stringify(base))
    dup.subGoals[1].stageIds = ["stage_1"]
    const { errors } = normalizeGoal(dup, { objective: "x", stageIds: ["stage_1", "stage_2"] })
    assert.ok(errors.some((e) => /exactly one owner/.test(e)))
  })

  it("深度上限 2：子目标不得再嵌套", () => {
    const deep = JSON.parse(JSON.stringify(base))
    deep.subGoals[0].subGoals = [{ title: "nested" }]
    const { errors } = normalizeGoal(deep, { objective: "x" })
    assert.ok(errors.some((e) => /depth is capped/.test(e)))
  })

  it("子目标超过 6 个要求合并", () => {
    const many = { objective: "x", criteria: ["npm test passes"], subGoals: Array.from({ length: 7 }, (_, i) => ({ title: `s${i}` })) }
    const { errors } = normalizeGoal(many, { objective: "x" })
    assert.ok(errors.some((e) => /exceed 6/.test(e)))
  })

  it("既无判据也无子目标 → 无从核验", () => {
    const { errors } = normalizeGoal({ objective: "x" }, { objective: "x" })
    assert.ok(errors.some((e) => /nothing to verify/.test(e)))
  })
})

describe("reviseGoal 修订留痕", () => {
  function makeGoal() {
    const { goal } = normalizeGoal({
      objective: "x",
      criteria: ["npm test passes", "perf 不退化算达标吗", "src/a.mjs"]
    }, { objective: "x" })
    return freezeGoal(goal)
  }

  it("新增自由，删除 blocking 必须给理由", () => {
    const goal = makeGoal()
    const noReason = reviseGoal(goal, { round: 2, drop: [goal.criteria[0].id] })
    assert.ok(noReason.errors.some((e) => /requires a reason/.test(e)))
    assert.equal(noReason.goal.criteria.length, 3, "没理由就不删")

    const withReason = reviseGoal(goal, {
      round: 2, reason: "范围调整",
      drop: [{ id: goal.criteria[2].id, reason: "该文件并入 b.mjs" }],
      add: ["src/b.mjs"]
    })
    assert.deepEqual(withReason.errors, [])
    assert.equal(withReason.goal.criteria.length, 3)
    const revision = withReason.goal.revisions[0]
    assert.equal(revision.removed[0].reason, "该文件并入 b.mjs", "删除记录必须带理由进报告")
    assert.equal(revision.added.length, 1)
  })

  it("manual 判据永不可删", () => {
    const goal = makeGoal()
    const manualId = goal.criteria.find((c) => c.kind === "manual").id
    const attempt = reviseGoal(goal, { round: 2, reason: "r", drop: [{ id: manualId, reason: "嫌麻烦" }] })
    assert.ok(attempt.errors.some((e) => /can never be dropped/.test(e)))
    assert.ok(attempt.goal.criteria.some((c) => c.id === manualId))
  })
})

test("planSignature 只看结构不看措辞", () => {
  const plan = { stages: [{ stageId: "s1", tasks: [{ taskId: "t1", plannedFiles: ["a.mjs"], prompt: "写 a" }] }] }
  const reworded = JSON.parse(JSON.stringify(plan))
  reworded.stages[0].tasks[0].prompt = "完全不同的措辞来写 a"
  assert.equal(planSignature(plan), planSignature(reworded), "措辞变化不该改变签名")

  const structural = JSON.parse(JSON.stringify(plan))
  structural.stages[0].tasks[0].plannedFiles = ["b.mjs"]
  assert.notEqual(planSignature(plan), planSignature(structural), "文件清单变化必须改变签名")
})
