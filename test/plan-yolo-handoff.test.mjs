import test from "node:test"
import assert from "node:assert/strict"
import { askPlanApproval, setQuestionPromptHandler } from "../src/tool/question-prompt.mjs"
import { planBuildModeId, planApprovalInstruction } from "../src/session/loop.mjs"
import { isModeId, approvalOf } from "../src/core/modes.mjs"

/**
 * 计划做完之后的去向。
 *
 * 这里的断言全部**由选项枚举驱动**：选项表在 question-prompt.mjs，模式映射与
 * 指令文案在 loop.mjs，三份东西必须一起长。手写「第 5 项是 yolo」这类断言在
 * 插入一个选项时会静默错位，而这个仓库已经因为「清单手写」栽过一次。
 *
 * Yolo Build 尤其不能只当成一个标签：它关掉的是审批本身，所以下面有一条专门
 * 断言它真的落到 yolo 审批档，而不只是名字里带 yolo。
 */

/** 驱动一次计划审批。answerFor 拿到问题本体，回一个答案字符串。 */
async function ask(answerFor) {
  let captured = null
  setQuestionPromptHandler(({ questions }) => {
    captured = questions[0]
    return Promise.resolve({ plan_approval: answerFor(questions[0]) })
  })
  try {
    const result = await askPlanApproval({ plan: "计划正文", planPath: "/tmp/plan.md" })
    return { result, question: captured }
  } finally {
    setQuestionPromptHandler(null)
  }
}

const optionsOf = async () => (await ask(() => "revise")).question.options

test("计划完成后可以直接以 yolo 模式执行", async () => {
  const { result, question } = await ask((q) => q.options.find((o) => o.value === "yolo")?.value || "")
  assert.ok(question.options.some((o) => o.value === "yolo"),
    "计划审批里必须有一项是「免审批执行」—— 否则用户只能退出去 /yolo 再重来一遍")
  assert.equal(result.action, "yolo")
  assert.equal(result.approved, true)
  assert.equal(result.requestChanges, false)
  assert.equal(result.planPath, "/tmp/plan.md")
})

test("Yolo 那一项的文案把代价写在脸上", async () => {
  const yolo = (await optionsOf()).find((o) => o.value === "yolo")
  assert.match(yolo.label, /yolo/i)
  assert.match(yolo.description, /approvals? (are )?off/i,
    "描述必须说明审批被关掉，光写「无人值守」看不出代价")
  assert.match(yolo.description, /confirmation/i)
})

test("数字答案按选项位置解析，而不是一条手写的判等阶梯", async () => {
  // 此前是 `answer === "1"` … `answer === "5"` 五条并列的 if。往中间插一项，
  // 数字还在、指向的却是隔壁那一项，而且不会有任何东西红。
  const options = await optionsOf()
  for (let i = 0; i < options.length; i++) {
    const { result } = await ask(() => String(i + 1))
    assert.equal(result.action, options[i].value,
      `第 ${i + 1} 项应当解析成 ${options[i].value}`)
  }
})

test("原有选项的语义一个都没变", async () => {
  for (const value of ["assistant", "longagent", "compact_assistant", "compact_longagent"]) {
    const { result } = await ask(() => value)
    assert.equal(result.action, value)
    assert.equal(result.approved, true)
  }
  const revise = await ask(() => "revise")
  assert.equal(revise.result.action, "revise")
  assert.equal(revise.result.approved, false)
  assert.equal(revise.result.requestChanges, true)
})

test("自由文本仍然当作修改意见，即使它以数字开头", async () => {
  const { result } = await ask(() => "3 个阶段都要拆开")
  assert.equal(result.action, "revise")
  assert.equal(result.feedback, "3 个阶段都要拆开")
})

test("每个执行选项都映射得出真实模式，并且有自己的指令文案", async () => {
  const options = await optionsOf()
  for (const option of options) {
    if (option.value === "revise") continue
    const modeId = planBuildModeId(option.value)
    assert.ok(modeId, `选项 ${option.value} 没有登记执行模式 —— 会静默回落到 agent`)
    assert.ok(isModeId(modeId), `选项 ${option.value} 映射到了不存在的模式 ${modeId}`)
    const instruction = planApprovalInstruction(option.value, "/tmp/plan.md")
    assert.ok(instruction, `选项 ${option.value} 没有指令文案 —— 模型只会收到一句泛化的「按所选路径继续」`)
    assert.ok(instruction.includes("/tmp/plan.md"), `选项 ${option.value} 的指令没带上计划文件路径`)
  }
})

test("Yolo Build 落到的是免审批档，不只是个名字里带 yolo 的模式", async () => {
  // 这是安全边界：切过去之后判定链读的是这个档。名字对、档位没降的话，
  // 用户以为自己开了无人值守，实际每个工具调用还在等确认（反之更糟）。
  assert.equal(planBuildModeId("yolo"), "yolo")
  assert.equal(approvalOf(planBuildModeId("yolo")), "yolo")
  assert.equal(approvalOf(planBuildModeId("assistant")), "manual", "Build 不该顺带放宽审批")
  assert.equal(approvalOf(planBuildModeId("longagent")), "accept-edits")
})

test("yolo 的指令明确告诉模型审批已经关掉", async () => {
  const text = planApprovalInstruction("yolo", "/tmp/plan.md")
  assert.match(text, /approvals are OFF/i)
  assert.match(text, /YOLO/)
})

test("不认识的选择不映射成模式，交给调用点回落", async () => {
  // planBuildModeId 自己回落到 agent 的话，「加了选项忘了登记」会得到一个
  // 合法模式 id，上面那条枚举断言就会对着回落值成立、永远不红。
  assert.equal(planBuildModeId("compact_yolo"), null)
  assert.equal(planBuildModeId("plan_saved"), null)
  assert.equal(planApprovalInstruction("compact_yolo"), null)
})
