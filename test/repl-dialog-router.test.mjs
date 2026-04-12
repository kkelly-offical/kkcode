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
