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

// --- 过滤态下的提交换算（0.8.0） ---

test("a filtered single-select commits the option the user sees, not the raw index", () => {
  const question = {
    id: "model",
    options: [
      { label: "gpt-5.5", value: "gpt-5.5" },
      { label: "claude-sonnet-4-6", value: "claude-sonnet-4-6" },
      { label: "kimi-k2.6", value: "kimi-k2.6" }
    ]
  }
  // 过滤 "kimi" 后显示位置 0 是 kimi-k2.6（原下标 2）。
  // 不做换算的话 options[0] 会把 gpt-5.5 交出去 —— 用户看着 kimi 按的回车。
  const next = commitQuestionAnswer({
    pendingQuestion: { questions: [question] },
    questionIndex: 0,
    questionOptionSelected: 0,
    questionFilter: "kimi",
    questionMultiSelected: {},
    questionCustomMode: false,
    questionCustomInput: "",
    questionAnswers: {}
  })
  assert.equal(next.questionAnswers.model, "kimi-k2.6")
})

test("a filtered-to-nothing single-select commits no answer at all", () => {
  const next = commitQuestionAnswer({
    pendingQuestion: { questions: [{ id: "m", options: [{ label: "甲" }] }] },
    questionIndex: 0,
    questionOptionSelected: 0,
    questionFilter: "zzz",
    questionMultiSelected: {},
    questionCustomMode: false,
    questionCustomInput: "",
    questionAnswers: {}
  })
  assert.equal(next.questionAnswers.m, undefined,
    "零命中时不能把 undefined 折成某个选项交出去")
})

test("multi-select commit reads source indices regardless of any filter", () => {
  const question = {
    id: "models",
    multi: true,
    options: [
      { label: "a", value: "a" }, { label: "b", value: "b" }, { label: "c", value: "c" }
    ]
  }
  // 集合存的是 sourceIndex —— 过滤串在提交时是什么都不影响勾选内容
  const next = commitQuestionAnswer({
    pendingQuestion: { questions: [question] },
    questionIndex: 0,
    questionOptionSelected: 0,
    questionFilter: "b",
    questionMultiSelected: { models: new Set([0, 2]) },
    questionCustomMode: false,
    questionCustomInput: "",
    questionAnswers: {}
  })
  assert.equal(next.questionAnswers.models, "a, c")
})

test("advancing to the next question clears the filter", () => {
  const advanced = advanceQuestionState({
    pendingQuestion: { questions: [{ id: "a" }, { id: "b" }] },
    questionIndex: 0,
    questionOptionSelected: 1,
    questionFilter: "leftover",
    questionCustomMode: false,
    questionCustomInput: "",
    questionCustomCursor: 0
  })
  assert.equal(advanced.questionFilter, "")
  assert.equal(advanced.questionOptionOffset, 0)
})
