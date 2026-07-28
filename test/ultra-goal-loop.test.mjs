import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * Goal 轮次循环的端到端行为 —— 用 harness 驱动完整的 runHybridLongAgent。
 *
 * 覆盖计划里点名的场景：次轮达成（重规划真的被调、prompt 里真的有失败证据）、
 * stage 永久失败但无依赖 → SKIP 后照样完成、barrier 抛错不穿透且监听器归零、
 * 用户指引进入下一轮。首轮达成 / 停滞收口 / goal_mode:false 分别由
 * parity 与 continuous 测试钉住。
 */

const tmpHome = await mkdtemp(path.join(os.tmpdir(), "kkcode-goalloop-home-"))
const tmpProject = await mkdtemp(path.join(os.tmpdir(), "kkcode-goalloop-proj-"))
process.env.KKCODE_HOME = tmpHome
const originalCwd = process.cwd()
process.chdir(tmpProject)

const { EventBus } = await import("../src/core/events.mjs")
const { EVENT_TYPES } = await import("../src/core/constants.mjs")
const { registerProvider } = await import("../src/provider/router.mjs")
const { runHybridLongAgent } = await import("../src/session/longagent-hybrid.mjs")
const { loadLedger } = await import("../src/session/ultra-ledger.mjs")
const { stagePlanFence, ultraConfig } = await import("./helpers/ultra-harness.mjs")
const { installBackgroundMock, restoreBackgroundMock } = await import("./helpers/background-mock.mjs")
const { mkdir, writeFile } = await import("node:fs/promises")

test.after(async () => {
  restoreBackgroundMock()
  process.chdir(originalCwd)
  await rm(tmpHome, { recursive: true, force: true }).catch(() => {})
  await rm(tmpProject, { recursive: true, force: true }).catch(() => {})
})

/** 每个用例独立的 provider + mock 组合，跑完即还原。 */
async function withMocks({ providerRules, fallback = "acknowledged", behavior = null, onRequest = null }, fn) {
  registerProvider("mock_goalloop", (await import("./helpers/ultra-harness.mjs")).createScriptedProvider(providerRules, { fallback, onRequest }))
  installBackgroundMock({ reply: "[TASK_COMPLETE] done", behavior })
  try {
    return await fn()
  } finally {
    restoreBackgroundMock()
  }
}

test("次轮达成：重规划被调用且 prompt 含上一轮的失败证据", async () => {
  // 判据要求 version = 2；第一轮的计划只会写出 version = 1 → 判据失败 →
  // 重规划产出 v2 计划 → 第二轮达成。
  const PLAN_V1 = {
    planId: "p1", objective: "ship v2",
    goal: {
      objective: "ship v2", intent: "code",
      criteria: [{ kind: "content_match", text: "out.mjs 有 version 2", spec: { path: "src/out.mjs", pattern: "export const version = 2" } }]
    },
    stages: [{ stageId: "s1", name: "V1", tasks: [{ taskId: "t_v1", prompt: "write MODE_V1 file", plannedFiles: ["src/out.mjs"], acceptance: ["src/out.mjs"] }] }]
  }
  const PLAN_V2 = {
    planId: "p2", objective: "ship v2",
    stages: [{ stageId: "s2", name: "V2", tasks: [{ taskId: "t_v2", prompt: "write MODE_V2 file", plannedFiles: ["src/out.mjs"], acceptance: ["src/out.mjs"] }] }]
  }

  const replanPrompts = []
  const result = await withMocks({
    providerRules: [
      { match: /重规划原因/, reply: stagePlanFence(PLAN_V2) },   // 重规划请求（先匹配，避免落到 stage 规则）
      { stage: 1, reply: "Findings: ok." },
      { stage: 2, reply: stagePlanFence(PLAN_V1) },
      { stage: 4, reply: "checks pass\n[STAGE 4/4: DEBUGGING - COMPLETE]\n[TASK_COMPLETE]" }
    ],
    onRequest: ({ last }) => { if (/重规划原因/.test(last)) replanPrompts.push(last) },
    behavior: async (payload) => {
      // 按任务提示词里的标记决定写 v1 还是 v2 —— 模拟「换了路线才能成」。
      // 标记必须是目标语句里不存在的词：worker 收到的是组合提示词（含计划
      // 锚点与 objective），拿自然语言当开关会被 objective 里的措辞误触发。
      const version = /MODE_V2/.test(payload?.prompt || "") ? 2 : 1
      const target = path.resolve(process.cwd(), "src/out.mjs")
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, `export const version = ${version}\n`, "utf8")
      return null   // 走默认的 completed 结果
    }
  }, () => runHybridLongAgent({
    prompt: "ship version two of the module",
    model: "mock-model", providerType: "mock_goalloop",
    sessionId: "gl_replan", configState: ultraConfig({ providerName: "mock_goalloop" })
  }))

  assert.equal(result.status, "completed", "第二轮换路线后达成")
  assert.equal(replanPrompts.length, 1, "重规划恰好调用一次")
  assert.match(replanPrompts[0], /尚未达成的判据/, "重规划的输入必须有失败判据")
  assert.match(replanPrompts[0], /version = 2|version 2/, "失败证据里要有判据内容")
  assert.match(replanPrompts[0], /已冻结的验收判据/, "冻结判据必须原样传达")

  const ledger = await loadLedger("gl_replan", tmpProject)
  assert.equal(ledger.data.rounds.length, 2)
  assert.equal(ledger.data.rounds[0].criteria[0].status, "fail")
  assert.equal(ledger.data.rounds[1].criteria[0].status, "pass")
})

test("stage 永久失败但无依赖 → SKIP 后其余照样完成", async () => {
  // stage_flaky 的任务永久失败（EACCES）且没有下游依赖 —— 0.4.x 会退避重试
  // 12 轮然后 break 掉一切；现在应当 SKIP 它，让 stage_solid 完成并达成判据。
  const PLAN = {
    planId: "p", objective: "solid part",
    goal: {
      objective: "solid part", intent: "code",
      criteria: [{ kind: "file_exists", text: "solid 产物在", spec: { path: "src/solid.mjs" } }]
    },
    stages: [
      { stageId: "stage_flaky", name: "Flaky", tasks: [{ taskId: "t_flaky", prompt: "write locked file", plannedFiles: ["src/locked.mjs"], acceptance: ["src/locked.mjs"] }] },
      { stageId: "stage_solid", name: "Solid", tasks: [{ taskId: "t_solid", prompt: "write solid file", plannedFiles: ["src/solid.mjs"], acceptance: ["src/solid.mjs"] }] }
    ]
  }

  const result = await withMocks({
    providerRules: [
      { stage: 1, reply: "Findings: ok." },
      { stage: 2, reply: stagePlanFence(PLAN) },
      { stage: 4, reply: "checks pass\n[STAGE 4/4: DEBUGGING - COMPLETE]\n[TASK_COMPLETE]" }
    ],
    behavior: async (payload) => {
      if (/locked/.test(payload?.prompt || "")) {
        return { error: "EACCES: permission denied, open '/etc/locked'" }
      }
      const target = path.resolve(process.cwd(), "src/solid.mjs")
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, "export const solid = true\n", "utf8")
      return null
    }
  }, () => runHybridLongAgent({
    prompt: "build the solid part",
    model: "mock-model", providerType: "mock_goalloop",
    sessionId: "gl_skip",
    // maxReplans 0：逼决策表走 SKIP 而不是 REPLAN
    configState: ultraConfig({ providerName: "mock_goalloop" }, { ultra: { stage_failure: { max_replans: 0 } } })
  }))

  assert.equal(result.status, "completed", "无关 stage 的失败不该没收目标达成")
  assert.equal(result.taskProgress.t_flaky.status, "skipped")
  assert.equal(result.taskProgress.t_solid.status, "completed")
  assert.equal(result.gateStatus.stage_flaky.kind, "skipped")
})

test("barrier 抛错（依赖环）不穿透：重规划兜住，监听器归零", async () => {
  const CYCLE_PLAN = {
    planId: "pc", objective: "cyclic",
    goal: {
      objective: "cyclic", intent: "code",
      criteria: [{ kind: "file_exists", text: "产物在", spec: { path: "src/ok.mjs" } }]
    },
    stages: [{
      stageId: "s_cycle", name: "Cycle",
      tasks: [
        { taskId: "t_a", prompt: "a", plannedFiles: ["src/a.mjs"], dependsOn: ["t_b"], acceptance: ["src/a.mjs"] },
        { taskId: "t_b", prompt: "b", plannedFiles: ["src/b.mjs"], dependsOn: ["t_a"], acceptance: ["src/b.mjs"] }
      ]
    }]
  }
  const FIXED_PLAN = {
    planId: "pf", objective: "cyclic",
    stages: [{ stageId: "s_ok", name: "Fixed", tasks: [{ taskId: "t_ok", prompt: "write ok", plannedFiles: ["src/ok.mjs"], acceptance: ["src/ok.mjs"] }] }]
  }

  const before = EventBus.listenerCount()
  const result = await withMocks({
    providerRules: [
      { match: /重规划原因/, reply: stagePlanFence(FIXED_PLAN) },
      { stage: 1, reply: "Findings: ok." },
      { stage: 2, reply: stagePlanFence(CYCLE_PLAN) },
      { stage: 4, reply: "checks pass\n[STAGE 4/4: DEBUGGING - COMPLETE]\n[TASK_COMPLETE]" }
    ]
  }, () => runHybridLongAgent({
    prompt: "build it",
    model: "mock-model", providerType: "mock_goalloop",
    sessionId: "gl_cycle", configState: ultraConfig({ providerName: "mock_goalloop" })
  }))

  assert.equal(EventBus.listenerCount(), before, "barrier 异常不得泄漏监听器")
  assert.equal(result.status, "completed", "计划缺陷经重规划修复后完成")
  const ledger = await loadLedger("gl_cycle", tmpProject)
  assert.ok(ledger.data.rounds.length >= 2, "至少两轮（缺陷轮 + 修复轮）")

  // 0.4.x 在这里是异常穿透：unsubscribeStop 泄漏、会话永久 running、工作全丢
  const { LongAgentManager } = await import("../src/orchestration/longagent-manager.mjs")
  const record = await LongAgentManager.get("gl_cycle")
  assert.equal(record.status, "completed")
})

test("多目标：已达成子目标的 stage 下一轮整段跳过", async () => {
  // 子目标 A 首轮达成；子目标 B 首轮失败需换路线。第二轮必须只跑 B 的
  // stage —— A 的任务不得被重新派发（那是白费往返，也是重新脚手架的风险面）。
  const PLAN_TREE = {
    planId: "pt", objective: "two deliverables",
    goal: {
      objective: "two deliverables", intent: "code",
      subGoals: [
        { title: "part A", criteria: [{ kind: "file_exists", text: "A 在", spec: { path: "src/partA.mjs" } }], stageIds: ["stage_a"] },
        { title: "part B", criteria: [{ kind: "content_match", text: "B 用 MODE_RIGHT", spec: { path: "src/partB.mjs", pattern: "MODE_RIGHT" } }], stageIds: ["stage_b"] }
      ]
    },
    stages: [
      { stageId: "stage_a", name: "A", tasks: [{ taskId: "t_a", prompt: "write TOKEN_PART_A file", plannedFiles: ["src/partA.mjs"], acceptance: ["src/partA.mjs"] }] },
      { stageId: "stage_b", name: "B", tasks: [{ taskId: "t_b", prompt: "write part B the MODE_WRONG way", plannedFiles: ["src/partB.mjs"], acceptance: ["src/partB.mjs"] }] }
    ]
  }
  const PLAN_B_FIXED = {
    planId: "pb", objective: "two deliverables",
    stages: [
      { stageId: "stage_b2", name: "B fixed", tasks: [{ taskId: "t_b2", prompt: "write part B the MODE_RIGHT way", plannedFiles: ["src/partB.mjs"], acceptance: ["src/partB.mjs"] }] }
    ]
  }

  const dispatched = []
  const unsubscribe = EventBus.subscribe((e) => {
    if (e.type === "longagent.stage.task.dispatched" && e.sessionId === "gl_subgoal") {
      dispatched.push(e.payload?.taskId || e.payload?.logicalTaskId || "?")
    }
  })

  const result = await withMocks({
    providerRules: [
      { match: /重规划原因/, reply: stagePlanFence(PLAN_B_FIXED) },
      { stage: 1, reply: "Findings: ok." },
      { stage: 2, reply: stagePlanFence(PLAN_TREE) },
      { stage: 4, reply: "checks pass\n[STAGE 4/4: DEBUGGING - COMPLETE]\n[TASK_COMPLETE]" }
    ],
    behavior: async (payload) => {
      // 同一个坑的又一变体：payload.prompt 是组合提示词，计划锚点里带着目标
      // 语句 "deliver part A and part B" —— 用自然语言 /part A/ 判定会把 B 的
      // 修复任务也误判成 A。开关只能用目标语句里不存在的标记。
      const prompt = payload?.prompt || ""
      if (/TOKEN_PART_A/.test(prompt)) {
        const target = path.resolve(process.cwd(), "src/partA.mjs")
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, "export const a = true\n", "utf8")
        return null
      }
      const mode = /MODE_RIGHT/.test(prompt) ? "MODE_RIGHT" : "MODE_WRONG"
      const target = path.resolve(process.cwd(), "src/partB.mjs")
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, `export const mode = "${mode}"\n`, "utf8")
      return null
    }
  }, () => runHybridLongAgent({
    prompt: "deliver part A and part B",
    model: "mock-model", providerType: "mock_goalloop",
    sessionId: "gl_subgoal", configState: ultraConfig({ providerName: "mock_goalloop" })
  }))
  unsubscribe()

  assert.equal(result.status, "completed")
  assert.equal(result.goalVerification.subGoals.length, 2)
  assert.ok(result.goalVerification.subGoals.every((sg) => sg.status === "met"))

  // stage_a 的任务只在第一轮派发过一次 —— 第二轮的作用域收窄到了未达成的 B
  const aDispatches = dispatched.filter((id) => id === "t_a").length
  assert.equal(aDispatches, 1, `t_a 被派发了 ${aDispatches} 次，已达成子目标的 stage 不该重跑`)

  const ledger = await loadLedger("gl_subgoal", tmpProject)
  const round1Subs = ledger.data.rounds[0].subGoals
  assert.equal(round1Subs.find((sg) => sg.title === "part A").status, "met")
  assert.equal(round1Subs.find((sg) => sg.title === "part B").status, "unmet")
})

/**
 * [GOAL_ACHIEVED] —— [GOAL_BLOCKED] 的对称信号（0.8.0）。
 *
 * 全部三条用例守的是同一条线：**声明是时机，不是结论**。它买到的只有「现在就
 * 核验」，达成与否永远由判据说了算。这条线一旦松掉，Ultra 就退回成「模型说完了
 * 就算完了」——而那正是 completionMarkerSeen 被刻意降权的原因。
 */

test("[GOAL_ACHIEVED] 提前触发核验：判据真的满足，当轮结束", async () => {
  const PLAN = {
    planId: "pca", objective: "ship the artifact",
    goal: {
      objective: "ship the artifact", intent: "code",
      criteria: [{ kind: "file_exists", text: "产物在", spec: { path: "src/claim_a.mjs" } }]
    },
    stages: [{ stageId: "s_a", name: "A", tasks: [{ taskId: "t_ca", prompt: "write the artifact", plannedFiles: ["src/claim_a.mjs"], acceptance: ["src/claim_a.mjs"] }] }]
  }

  const result = await withMocks({
    providerRules: [
      { stage: 1, reply: "Findings: ok." },
      { stage: 2, reply: stagePlanFence(PLAN) },
      // 关键：既没有 [STAGE 4/4 - COMPLETE] 也没有 [TASK_COMPLETE]。
      // 能结束 H5 调试循环（上限 20 轮）的只有这条结构化声明。
      { stage: 4, reply: "产物已写好。\n[GOAL_ACHIEVED: 判据都满足了]" }
    ],
    behavior: async () => {
      const target = path.resolve(process.cwd(), "src/claim_a.mjs")
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, "export const ok = true\n", "utf8")
      return null
    }
  }, () => runHybridLongAgent({
    prompt: "ship the artifact",
    model: "mock-model", providerType: "mock_goalloop",
    sessionId: "gl_claim_ok", configState: ultraConfig({ providerName: "mock_goalloop" })
  }))

  assert.equal(result.status, "completed")
  assert.equal(
    result.gateStatus.debugging.status,
    "goal_achieved_claim",
    "结束调试循环的必须是声明本身，而不是别的标记"
  )
  assert.equal(result.gateStatus.debugging.iterations, 1, "声明的收益就是省掉剩下的 19 轮空转")

  const ledger = await loadLedger("gl_claim_ok", tmpProject)
  assert.equal(ledger.data.rounds.length, 1, "达成了就不该有第二轮")
  assert.deepEqual(ledger.data.planDefects, [], "说对了不算缺陷")
})

test("假声明：判据没过就记进台账、并入下一轮重规划输入，循环继续", async () => {
  // 判据要 version = 2，第一轮的计划只写得出 version = 1 —— 模型却声明达成。
  // 这种分歧是 goal 模式里最有价值的信号：模型的世界模型第一次与现实对不上。
  const PLAN_V1 = {
    planId: "pcb1", objective: "ship v2",
    goal: {
      objective: "ship v2", intent: "code",
      criteria: [{ kind: "content_match", text: "claim_b 有 version 2", spec: { path: "src/claim_b.mjs", pattern: "export const version = 2" } }]
    },
    stages: [{ stageId: "s_b1", name: "B1", tasks: [{ taskId: "t_cb1", prompt: "write MODE_V1 file", plannedFiles: ["src/claim_b.mjs"], acceptance: ["src/claim_b.mjs"] }] }]
  }
  const PLAN_V2 = {
    planId: "pcb2", objective: "ship v2",
    stages: [{ stageId: "s_b2", name: "B2", tasks: [{ taskId: "t_cb2", prompt: "write MODE_V2 file", plannedFiles: ["src/claim_b.mjs"], acceptance: ["src/claim_b.mjs"] }] }]
  }

  const replanPrompts = []
  const result = await withMocks({
    providerRules: [
      { match: /重规划原因/, reply: stagePlanFence(PLAN_V2) },
      { stage: 1, reply: "Findings: ok." },
      { stage: 2, reply: stagePlanFence(PLAN_V1) },
      { stage: 4, reply: "全都搞定了。\n[GOAL_ACHIEVED: 我认为判据都满足了]" }
    ],
    onRequest: ({ last }) => { if (/重规划原因/.test(last)) replanPrompts.push(last) },
    behavior: async (payload) => {
      const version = /MODE_V2/.test(payload?.prompt || "") ? 2 : 1
      const target = path.resolve(process.cwd(), "src/claim_b.mjs")
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, `export const version = ${version}\n`, "utf8")
      return null
    }
  }, () => runHybridLongAgent({
    prompt: "ship version two of claim_b",
    model: "mock-model", providerType: "mock_goalloop",
    sessionId: "gl_claim_false", configState: ultraConfig({ providerName: "mock_goalloop" })
  }))

  assert.equal(result.status, "completed", "第二轮换路线后才真的达成")

  const ledger = await loadLedger("gl_claim_false", tmpProject)
  assert.equal(ledger.data.rounds.length, 2, "假声明不得终结循环")
  const defect = ledger.data.planDefects.find((d) => /模型自称目标已达成/.test(d.message))
  assert.ok(defect, `分歧必须留痕，实际缺陷: ${JSON.stringify(ledger.data.planDefects)}`)
  assert.match(defect.message, /version = 2/, "留痕要说清是哪一条判据没满足")

  assert.equal(replanPrompts.length, 1)
  // 必须落在「重规划原因」那一段里，不能只在台账证据里出现 ——
  // ledger.snapshotForReplan() 本来就会把 planDefects 一并喂进来，
  // 对整份 prompt 做匹配的话，就算 replanReason 完全没带上分歧也照样绿。
  const reasonSection = replanPrompts[0].split("## 重规划原因")[1]?.split("## 你的任务")[0] || ""
  assert.match(
    reasonSection,
    /模型自称目标已达成/,
    `分歧必须并入重规划原因，让模型直面「你以为完成了，实际没有」。实际那一段：${reasonSection}`
  )
})

test("只有声明、判据始终不过：绝不产生 completed", async () => {
  // 声明喊得再响也抬不动终局状态。这条钉的是 completionMarkerSeen 被降权的
  // 同一条原则：自我声明不是证据。
  const PLAN = {
    planId: "pcc", objective: "impossible",
    goal: {
      objective: "impossible", intent: "code",
      criteria: [{ kind: "file_exists", text: "永远不会被写出来的产物", spec: { path: "src/claim_c_never.mjs" } }]
    },
    stages: [{ stageId: "s_c", name: "C", tasks: [{ taskId: "t_cc", prompt: "write something else", plannedFiles: ["src/claim_c_other.mjs"], acceptance: ["src/claim_c_other.mjs"] }] }]
  }

  const result = await withMocks({
    providerRules: [
      { match: /重规划原因/, reply: stagePlanFence(PLAN) },
      { stage: 1, reply: "Findings: ok." },
      { stage: 2, reply: stagePlanFence(PLAN) },
      { stage: 4, reply: "任务完成。\n[GOAL_ACHIEVED: 全部达成]" }
    ],
    behavior: async () => {
      const target = path.resolve(process.cwd(), "src/claim_c_other.mjs")
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, "export const other = true\n", "utf8")
      return null
    }
  }, () => runHybridLongAgent({
    prompt: "do the impossible",
    model: "mock-model", providerType: "mock_goalloop",
    sessionId: "gl_claim_never",
    configState: ultraConfig({ providerName: "mock_goalloop" }, { ultra: { max_rounds: 1 } })
  }))

  // 先证明声明真的送达了 —— 否则这条用例只是「没达成的任务没达成」，空过。
  assert.equal(
    result.gateStatus.debugging.status,
    "goal_achieved_claim",
    "声明必须真的被识别，这条用例才有意义"
  )
  assert.notEqual(result.status, "completed", "声明不得产生 completed")
  assert.notEqual(result.goalVerification.status, "met")

  const ledger = await loadLedger("gl_claim_never", tmpProject)
  assert.ok(
    ledger.data.planDefects.some((d) => /模型自称目标已达成/.test(d.message)),
    "分歧必须留痕"
  )
})

test("插话送得到 Ultra：executeTurn → runLongAgent → H5 调试循环", async () => {
  // longagent 分支此前**根本没往下传 steerSource** —— 用户在 Ultra 里排队再按
  // 一次 Enter，消息进了 ui.steerPrompts 就再没人来取。而 Ultra 是跑得最久、
  // 最需要中途纠正的航道。这里走真实的 executeTurn，把 engine 的转发和 hybrid
  // 的接收一起钉住。
  const { executeTurn } = await import("../src/session/engine.mjs")
  const PLAN = {
    planId: "pst", objective: "steerable run",
    goal: {
      objective: "steerable run", intent: "code",
      criteria: [{ kind: "file_exists", text: "产物在", spec: { path: "src/steer_target.mjs" } }]
    },
    stages: [{ stageId: "s_st", name: "S", tasks: [{ taskId: "t_st", prompt: "write the target", plannedFiles: ["src/steer_target.mjs"], acceptance: ["src/steer_target.mjs"] }] }]
  }

  // 取走即负责送达：只交出一次，否则每个 step 边界都会再注入一遍。
  let pending = ["顺便看一眼 legacy 目录"]
  const injected = []
  const unsubscribe = EventBus.subscribe((event) => {
    if (event.type === EVENT_TYPES.TURN_STEER_INJECTED && event.sessionId === "gl_steer") {
      injected.push(event.payload?.text)
    }
  })

  try {
    const result = await withMocks({
      providerRules: [
        { stage: 1, reply: "Findings: ok." },
        { stage: 2, reply: stagePlanFence(PLAN) },
        { stage: 4, reply: "checks pass\n[STAGE 4/4: DEBUGGING - COMPLETE]\n[TASK_COMPLETE]" }
      ],
      behavior: async () => {
        const target = path.resolve(process.cwd(), "src/steer_target.mjs")
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, "export const target = true\n", "utf8")
        return null
      }
    }, () => executeTurn({
      prompt: "build the steerable target",
      mode: "longagent",
      model: "mock-model", providerType: "mock_goalloop",
      sessionId: "gl_steer",
      // executeTurn 比 runHybridLongAgent 多走一段计价/预算收尾，那里读的是
      // configState.source（ultraConfig 只造 .config）。空来源 = 用内置费率表。
      configState: { ...ultraConfig({ providerName: "mock_goalloop" }), source: {} },
      steerSource: () => pending.splice(0)
    }))

    assert.equal(result.longagent?.status ?? result.status, "completed")
    assert.deepEqual(injected, ["顺便看一眼 legacy 目录"], "插话必须恰好注入一次")
    assert.deepEqual(pending, [], "取走即清空 —— 留着副本会被反复注入")
  } finally {
    unsubscribe()
  }
})

test("用户指引进入下一轮的上下文", async () => {
  // 第一轮判据失败 → 停滞路径受阻询问 → 注入的交互给出指引 → 指引出现在
  // 重规划 prompt → 第二轮按指引完成
  const PLAN_STUBBORN = {
    planId: "ps", objective: "needs guidance",
    goal: {
      objective: "needs guidance", intent: "code",
      criteria: [{ kind: "content_match", text: "用 json 方案", spec: { path: "src/store.mjs", pattern: "json-backend" } }]
    },
    stages: [{ stageId: "s_wrong", name: "Wrong", tasks: [{ taskId: "t_wrong", prompt: "use MODE_SQLITE backend", plannedFiles: ["src/store.mjs"], acceptance: ["src/store.mjs"] }] }]
  }
  const PLAN_GUIDED = {
    planId: "pg", objective: "needs guidance",
    stages: [{ stageId: "s_right", name: "Right", tasks: [{ taskId: "t_right", prompt: "use MODE_JSON backend as instructed", plannedFiles: ["src/store.mjs"], acceptance: ["src/store.mjs"] }] }]
  }

  const replanPrompts = []
  const result = await withMocks({
    providerRules: [
      // 只有拿到用户指引才给出正确计划 —— 没有指引的重规划吐回同一份计划
      // （签名相同会被拒），逼流程走到停滞询问
      { match: /用户指引[\s\S]*MODE_JSON/, reply: stagePlanFence(PLAN_GUIDED) },
      { match: /重规划原因/, reply: stagePlanFence(PLAN_STUBBORN) },
      { stage: 1, reply: "Findings: ok." },
      { stage: 2, reply: stagePlanFence(PLAN_STUBBORN) },
      { stage: 4, reply: "checks pass\n[STAGE 4/4: DEBUGGING - COMPLETE]\n[TASK_COMPLETE]" }
    ],
    onRequest: ({ last }) => { if (/重规划原因/.test(last)) replanPrompts.push(last) },
    behavior: async (payload) => {
      const backend = /MODE_JSON/.test(payload?.prompt || "") ? "json-backend" : "sqlite-backend"
      const target = path.resolve(process.cwd(), "src/store.mjs")
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, `export const backend = "${backend}"\n`, "utf8")
      return null
    }
  }, () => runHybridLongAgent({
    prompt: "build the store",
    model: "mock-model", providerType: "mock_goalloop",
    sessionId: "gl_guidance",
    configState: ultraConfig({ providerName: "mock_goalloop" }, { ultra: { no_progress_rounds: 1 } }),
    // 注入交互：受阻询问回答「给指引」
    deps: {
      hasPromptHandler: () => true,
      askQuestionInteractive: async ({ questions }) => {
        const q = questions[0]
        if (q.id === "ultra_blocked") return { ultra_blocked: "改用 MODE_JSON backend，不要 sqlite" }
        return {}
      }
    }
  }))

  assert.equal(result.status, "completed")
  const guided = replanPrompts.find((p) => /用户指引/.test(p))
  assert.ok(guided, "指引必须出现在重规划的 prompt 里")
  assert.match(guided, /MODE_JSON/)

  const ledger = await loadLedger("gl_guidance", tmpProject)
  const interaction = ledger.data.userInteractions.find((i) => i.action === "guidance")
  assert.ok(interaction, "指引交互必须记入台账")
  assert.equal(interaction.source, "user")
})
