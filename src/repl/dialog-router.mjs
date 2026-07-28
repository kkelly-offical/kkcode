import { visibleQuestionOptions } from "../ui/overlay-question.mjs"

export const QUESTION_SKIPPED = "(skipped)"

/**
 * 进入某个问题时，自由文本编辑区里该放什么。
 *
 * 不变量：**编辑缓冲区永远是「当前问题的答案」**。此前它是一个跨问题共用的
 * 全局缓冲：Tab 切到下一题时不清空，两道文本题会互相看到对方的半截输入；
 * 而切回上一题时又拿不回已经答过的内容。单问题的提示看不出来，一页多个文本
 * 字段（provider 表单：base_url / api_key / api_key_env）一上来就是错的。
 *
 * 取值顺序：已答过的取答案（哪怕是空串 —— 用户特意清空的字段不该被默认值填回去），
 * 没答过的取 `question.default`。
 */
export function questionTextBuffer(question, answers = {}) {
  if (!question) return ""
  const stored = answers[question.id]
  if (typeof stored === "string" && stored !== QUESTION_SKIPPED) return stored
  return typeof question.default === "string" ? question.default : ""
}

function bufferState(question, answers) {
  const text = questionTextBuffer(question, answers)
  return { questionCustomInput: text, questionCustomCursor: text.length }
}

export function activateNextQuestionState(queue = []) {
  if (!queue.length) {
    return {
      pendingQuestion: null,
      questionIndex: 0,
      questionOptionSelected: 0,
      questionOptionOffset: 0,
      questionMultiSelected: {},
      questionCustomMode: false,
      questionCustomInput: "",
      questionCustomCursor: 0,
      questionFilter: "",
      questionAnswers: {}
    }
  }

  const [pendingQuestion, ...rest] = queue
  return {
    queue: rest,
    pendingQuestion,
    questionIndex: 0,
    questionOptionSelected: 0,
    questionOptionOffset: 0,
    questionMultiSelected: {},
    questionCustomMode: false,
    ...bufferState((pendingQuestion.questions || [])[0], {}),
    questionFilter: "",
    questionAnswers: {}
  }
}

export function commitQuestionAnswer(state) {
  const questions = state.pendingQuestion?.questions || []
  const current = questions[state.questionIndex]
  if (!current) return state

  const nextAnswers = { ...state.questionAnswers }
  const options = Array.isArray(current.options) ? current.options : []
  if (state.questionCustomMode || options.length === 0) {
    nextAnswers[current.id] = state.questionCustomInput || ""
    return {
      ...state,
      questionAnswers: nextAnswers,
      questionCustomMode: false,
      questionCustomInput: state.questionCustomInput || "",
      questionCustomCursor: (state.questionCustomInput || "").length
    }
  }

  if (current.multi) {
    // 集合里存的是 sourceIndex（原始选项下标，见 visibleQuestionOptions 的
    // 注释）—— 过滤只改显示位置，不改集合语义，这里直接按原数组取即可。
    const selected = state.questionMultiSelected[current.id] || new Set()
    const values = [...selected]
      .map((index) => {
        const opt = options[index]
        return opt ? (opt.value || opt.label) : ""
      })
      .filter(Boolean)
    nextAnswers[current.id] = values.join(", ")
    return { ...state, questionAnswers: nextAnswers }
  }

  // 单选的 questionOptionSelected 是**显示位置**：过滤态下它指向过滤后的
  // 列表，直接当原数组下标用会提交到另一个选项 —— 必须经同一个派生函数换算。
  const visible = visibleQuestionOptions(current, state.questionFilter || "")
  const entry = visible[state.questionOptionSelected]
  if (entry) nextAnswers[current.id] = entry.option.value || entry.option.label
  return { ...state, questionAnswers: nextAnswers }
}

export function advanceQuestionState(state) {
  const questions = state.pendingQuestion?.questions || []
  if (state.questionIndex < questions.length - 1) {
    const nextIndex = state.questionIndex + 1
    return {
      ...state,
      questionIndex: nextIndex,
      questionOptionSelected: 0,
      questionOptionOffset: 0,
      questionCustomMode: false,
      // 过滤串属于「这一题」：带到下一题会让新列表被一个看不见的旧串滤空
      questionFilter: "",
      ...bufferState(questions[nextIndex], state.questionAnswers)
    }
  }
  return { ...state, shouldSubmit: true }
}

export function finalizeQuestionAnswers(pendingQuestion, questionAnswers = {}) {
  const answers = { ...questionAnswers }
  const questions = pendingQuestion?.questions || []
  for (const question of questions) {
    if (!(question.id in answers)) answers[question.id] = QUESTION_SKIPPED
  }
  return answers
}
