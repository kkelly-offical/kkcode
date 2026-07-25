import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import { askIntakeQuestions, renderIntakeAnswers, MAX_INTAKE_QUESTIONS } from "../src/session/intake-questions.mjs"

/**
 * 0.6.0 阶段 5：开工前真的问用户。
 *
 * 此前 planner.intake_questions 是模型自问自答（提示词要求「给出最佳假设」），
 * 一个问题都不会到用户面前。这批断言守住两件事：问得到时用答案，
 * 问不到时**显式**回落到假设而不是把空答案当成某个选择。
 */

const QUESTIONS = [
  { text: "认证用 JWT 还是 session？", why: "决定存储层设计", assumption: "JWT", options: ["JWT", "session"] },
  { text: "要不要兼容旧接口？", why: "影响改动范围", assumption: "兼容" }
]

function askReturning(answers) {
  return async () => answers
}

describe("能问到人时", () => {
  it("用户的回答覆盖假设，并标记来源为 user", async () => {
    const result = await askIntakeQuestions({
      questions: QUESTIONS,
      deps: {
        askQuestionInteractive: askReturning({ intake_1: "session", intake_2: "" }),
        hasPromptHandler: () => true,
        isTTY: true
      }
    })
    assert.equal(result.asked, true)
    assert.equal(result.answers[0].answer, "session")
    assert.equal(result.answers[0].source, "user")
    // 第二题没答 → 回落到假设，并如实标注
    assert.equal(result.answers[1].answer, "兼容")
    assert.equal(result.answers[1].source, "assumption")
  })

  it('"(skipped)" 与空串一样都不算回答', async () => {
    const result = await askIntakeQuestions({
      questions: QUESTIONS,
      deps: {
        askQuestionInteractive: askReturning({ intake_1: "(skipped)", intake_2: "(skipped)" }),
        hasPromptHandler: () => true,
        isTTY: true
      }
    })
    assert.equal(result.asked, false, "全跳过不该算作问到了人")
    assert.deepEqual(result.answers.map((a) => a.source), ["assumption", "assumption"])
  })

  it("题目数量有上限，避免变成盘问", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ text: `q${i}`, assumption: `a${i}` }))
    let received = 0
    await askIntakeQuestions({
      questions: many,
      deps: {
        askQuestionInteractive: async ({ questions }) => { received = questions.length; return {} },
        hasPromptHandler: () => true,
        isTTY: true
      }
    })
    assert.equal(received, MAX_INTAKE_QUESTIONS)
  })

  it("配置可以把上限压得更低", async () => {
    let received = 0
    await askIntakeQuestions({
      questions: QUESTIONS,
      config: { agent: { longagent: { planner: { intake_questions: { max_questions: 1 } } } } },
      deps: {
        askQuestionInteractive: async ({ questions }) => { received = questions.length; return {} },
        hasPromptHandler: () => true,
        isTTY: true
      }
    })
    assert.equal(received, 1)
  })
})

describe("问不到人时显式收口", () => {
  const blind = { hasPromptHandler: () => false, isTTY: false }

  it("非 TTY → 带着假设继续，并记录 why", async () => {
    const result = await askIntakeQuestions({ questions: QUESTIONS, deps: blind })
    assert.equal(result.asked, false)
    assert.equal(result.why, "non_tty")
    assert.deepEqual(result.answers.map((a) => a.answer), ["JWT", "兼容"])
  })

  it("allowQuestion:false → 同样带假设继续", async () => {
    const result = await askIntakeQuestions({
      questions: QUESTIONS, allowQuestion: false,
      deps: { hasPromptHandler: () => true, isTTY: true }
    })
    assert.equal(result.why, "allow_question_false")
  })

  it("配置关闭时不问", async () => {
    const result = await askIntakeQuestions({
      questions: QUESTIONS,
      config: { agent: { longagent: { planner: { intake_questions: { enabled: false } } } } },
      deps: { hasPromptHandler: () => true, isTTY: true }
    })
    assert.equal(result.why, "disabled_by_config")
  })

  it("提问本身抛错也不中断流程", async () => {
    const result = await askIntakeQuestions({
      questions: QUESTIONS,
      deps: {
        askQuestionInteractive: async () => { throw new Error("prompt died") },
        hasPromptHandler: () => true,
        isTTY: true
      }
    })
    assert.equal(result.why, "prompt_failed")
    assert.equal(result.answers[0].answer, "JWT")
  })

  it("没有问题时安静返回", async () => {
    const result = await askIntakeQuestions({ questions: [], deps: blind })
    assert.deepEqual(result, { asked: false, why: "no_questions", answers: [] })
  })
})

describe("注入规划提示词的文本", () => {
  it("用户确认与未确认的假设分开标注", () => {
    const text = renderIntakeAnswers({
      answers: [
        { question: "用 JWT？", answer: "session", source: "user" },
        { question: "兼容旧接口？", answer: "兼容", source: "assumption" }
      ]
    })
    assert.match(text, /\[用户确认\] session/)
    assert.match(text, /\[未确认的假设\] 兼容/)
    assert.match(text, /<requirements-clarified>/)
  })

  it("全是空答案时返回空串，不往提示词里塞噪音", () => {
    assert.equal(renderIntakeAnswers({ answers: [{ question: "q", answer: "", source: "unanswered" }] }), "")
    assert.equal(renderIntakeAnswers(null), "")
  })
})
