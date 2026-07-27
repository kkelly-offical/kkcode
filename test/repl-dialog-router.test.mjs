import test from "node:test"
import assert from "node:assert/strict"
import {
  QUESTION_SKIPPED,
  activateNextQuestionState,
  commitQuestionAnswer,
  advanceQuestionState,
  finalizeQuestionAnswers
} from "../src/repl/dialog-router.mjs"

test("activateNextQuestionState loads next queued question and resets fields", () => {
  const state = activateNextQuestionState([{ questions: [{ id: "q1" }] }, { questions: [{ id: "q2" }] }])
  assert.equal(state.pendingQuestion.questions[0].id, "q1")
  assert.equal(state.queue.length, 1)
  assert.equal(state.questionIndex, 0)
})

test("commitQuestionAnswer stores single-select choice", () => {
  const next = commitQuestionAnswer({
    pendingQuestion: { questions: [{ id: "q1", options: [{ label: "A" }, { label: "B", value: "bee" }] }] },
    questionIndex: 0,
    questionOptionSelected: 1,
    questionMultiSelected: {},
    questionCustomMode: false,
    questionCustomInput: "",
    questionAnswers: {}
  })
  assert.deepEqual(next.questionAnswers, { q1: "bee" })
})

test("commitQuestionAnswer preserves free text for an options-less Ctrl+Enter submit", () => {
  const next = commitQuestionAnswer({
    pendingQuestion: { questions: [{ id: "details", options: [] }] },
    questionIndex: 0,
    questionOptionSelected: 0,
    questionMultiSelected: {},
    questionCustomMode: false,
    questionCustomInput: "Use the staging database",
    questionCustomCursor: 24,
    questionAnswers: {}
  })

  assert.deepEqual(next.questionAnswers, {
    details: "Use the staging database"
  })
  assert.equal(next.questionCustomMode, false)
  // 0.7.3 起 commit **保留**编辑缓冲区（光标在末尾），不再清空。
  // 表单化（provider add）引入了「回到已答过的题」：进入题目时缓冲区由
  // advanceQuestionState 从答案或 question.default 恢复 —— commit 若清空，
  // Tab 回到本题的瞬间用户会看到自己刚写的内容闪没。提交后的清理归
  // resolveQuestionPrompt 的 resetQuestionState，职责没有丢。
  assert.equal(next.questionCustomInput, "Use the staging database")
  assert.equal(next.questionCustomCursor, "Use the staging database".length)
})

test("advanceQuestionState advances until submit", () => {
  const advanced = advanceQuestionState({
    pendingQuestion: { questions: [{ id: "a" }, { id: "b" }] },
    questionIndex: 0,
    questionOptionSelected: 2,
    questionCustomMode: true,
    questionCustomInput: "x",
    questionCustomCursor: 1
  })
  assert.equal(advanced.questionIndex, 1)
  assert.equal(advanced.questionCustomMode, false)

  const final = advanceQuestionState({
    pendingQuestion: { questions: [{ id: "a" }] },
    questionIndex: 0,
    questionOptionSelected: 0,
    questionCustomMode: false,
    questionCustomInput: "",
    questionCustomCursor: 0
  })
  assert.equal(final.shouldSubmit, true)
})

test("finalizeQuestionAnswers fills skipped placeholders", () => {
  const answers = finalizeQuestionAnswers(
    { questions: [{ id: "q1" }, { id: "q2" }] },
    { q1: "done" }
  )
  assert.deepEqual(answers, { q1: "done", q2: QUESTION_SKIPPED })
})
