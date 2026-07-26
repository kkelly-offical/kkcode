import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  validateCheckpoint,
  getGateFixStrategy,
  parseReplanMarker,
  extractFailedTaskIds,
  buildConflictResolutionPrompt,
  parseBlueprintOutput
} from "../src/session/longagent-hybrid-helpers.mjs"

/**
 * 0.6.0：这些函数原本埋在 longagent-hybrid.mjs 里，只能通过跑整条 Ultra
 * 流水线间接覆盖 —— 也就是基本没被覆盖。抽成模块后第一次可以直接断言。
 */

describe("checkpoint 校验", () => {
  it("结构不完整的检查点一律判无效", () => {
    assert.equal(validateCheckpoint(null), false)
    assert.equal(validateCheckpoint({}), false)
    assert.equal(validateCheckpoint({ stagePlan: {} }), false)
    assert.equal(validateCheckpoint({ stagePlan: { stages: "nope" }, stageIndex: 0 }), false)
  })

  it("stageIndex 必须是非负数且不越界", () => {
    const plan = { stagePlan: { stages: [{ stageId: "s1" }, { stageId: "s2" }] } }
    assert.equal(validateCheckpoint({ ...plan, stageIndex: 0 }), true)
    assert.equal(validateCheckpoint({ ...plan, stageIndex: 2 }), true, "指向末尾之后一位表示全部完成")
    assert.equal(validateCheckpoint({ ...plan, stageIndex: 3 }), false, "越界必须被拒")
    assert.equal(validateCheckpoint({ ...plan, stageIndex: -1 }), false)
    assert.equal(validateCheckpoint({ ...plan }), false, "缺 stageIndex 也是无效的")
  })

  it("恢复到第 N 阶段时，前一阶段必须真的存在", () => {
    const sparse = { stagePlan: { stages: [undefined, { stageId: "s2" }] }, stageIndex: 1 }
    assert.equal(validateCheckpoint(sparse), false)
  })
})

describe("重规划标记", () => {
  it("标记里的 JSON 被解析出来", () => {
    const marker = parseReplanMarker('前面\n[REPLAN: {"reason":"依赖顺序错了"}]\n后面')
    assert.deepEqual(marker, { reason: "依赖顺序错了" })
  })

  it("标记内不是合法 JSON 时返回 null，而不是把散文当计划", () => {
    assert.equal(parseReplanMarker("[REPLAN: 依赖顺序错了]"), null)
  })

  it("没有标记、空串、null 都安全", () => {
    assert.equal(parseReplanMarker("普通回复"), null)
    assert.equal(parseReplanMarker(""), null)
    assert.equal(parseReplanMarker(null), null)
  })
})

describe("失败任务 id 提取", () => {
  it("逐个捞出 [FAILED_TASK: x] 标记", () => {
    assert.deepEqual(
      extractFailedTaskIds("aaa [FAILED_TASK: t1] bbb [FAILED_TASK: t2] ccc"),
      ["t1", "t2"]
    )
  })

  it("无匹配时返回空数组，调用方不必判空", () => {
    assert.deepEqual(extractFailedTaskIds("nothing here"), [])
    assert.deepEqual(extractFailedTaskIds(""), [])
  })
})

describe("门禁修复策略路由", () => {
  it("测试失败优先交给 debugging-agent", () => {
    const strategy = getGateFixStrategy([{ gate: "build" }, { gate: "test" }])
    assert.equal(strategy.agent, "debugging-agent")
  })

  it("纯 build 失败交给 coding-agent", () => {
    assert.equal(getGateFixStrategy([{ gate: "build" }]).agent, "coding-agent")
  })

  it("纯 lint 失败先给出自动修复命令", () => {
    const strategy = getGateFixStrategy([{ gate: "lint" }])
    assert.match(strategy.autoFix, /eslint --fix/)
  })

  it("空列表与 null 都有可用的兜底策略", () => {
    for (const failures of [null, []]) {
      const strategy = getGateFixStrategy(failures)
      assert.equal(strategy.agent, "coding-agent")
      assert.ok(strategy.prefix)
    }
  })
})

describe("冲突解决提示词", () => {
  it("把冲突文件逐个列进提示词", () => {
    const prompt = buildConflictResolutionPrompt(["src/a.mjs", "src/b.mjs"])
    assert.match(prompt, /- src\/a\.mjs/)
    assert.match(prompt, /- src\/b\.mjs/)
    assert.match(prompt, /no <<<<<<< or ======= or >>>>>>> should remain/)
  })

  it("空列表不会产生半截提示词", () => {
    const prompt = buildConflictResolutionPrompt([])
    assert.match(prompt, /Resolution Protocol/)
  })
})

describe("blueprint 输出解析", () => {
  const defaults = { timeoutMs: 600000, maxRetries: 2 }

  it("解析不出计划时回落到兜底计划，而不是抛错或返回空", () => {
    const result = parseBlueprintOutput("完全不是 JSON 的散文", "目标", defaults)
    assert.ok(result.stagePlan, "必须给出一个可用的计划对象")
    assert.ok(Array.isArray(result.stagePlan.stages))
    assert.ok(result.stagePlan.stages.length > 0, "兜底计划至少要有一个阶段")
    assert.ok(result.parseErrors.length > 0, "回落必须留下可诊断的原因")
  })

  it("围栏里的合法计划被采用", () => {
    const fenced = [
      "```stage_plan_json",
      JSON.stringify({
        planId: "p1",
        objective: "目标",
        stages: [{ stageId: "s1", name: "S", tasks: [{ taskId: "t1", prompt: "do", plannedFiles: ["a.mjs"] }] }]
      }),
      "```"
    ].join("\n")
    const result = parseBlueprintOutput(fenced, "目标", defaults)
    assert.equal(result.stagePlan.stages.length, 1)
    assert.equal(result.stagePlan.stages[0].stageId, "s1")
    assert.deepEqual(result.parseErrors, [], "合法计划不该产生解析告警")
  })
})
