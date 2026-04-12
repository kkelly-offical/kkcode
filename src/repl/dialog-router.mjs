export const QUESTION_SKIPPED = "(skipped)"

export function activateNextQuestionState(queue = []) {
  if (!queue.length) {
    return {
      pendingQuestion: null,
      questionIndex: 0,
      questionOptionSelected: 0,
      questionMultiSelected: {},
      questionCustomMode: false,
      questionCustomInput: "",
      questionCustomCursor: 0,
      questionAnswers: {}
    }
  }

  const [pendingQuestion, ...rest] = queue
  return {
    queue: rest,
    pendingQuestion,
    questionIndex: 0,
    questionOptionSelected: 0,
    questionMultiSelected: {},
    questionCustomMode: false,
    questionCustomInput: "",
    questionCustomCursor: 0,
    questionAnswers: {}
  }
}

export function commitQuestionAnswer(state) {
  const questions = state.pendingQuestion?.questions || []
  const current = questions[state.questionIndex]
  if (!current) return state

  const nextAnswers = { ...state.questionAnswers }
  if (state.questionCustomMode) {
    nextAnswers[current.id] = state.questionCustomInput || ""
    return {
      ...state,
      questionAnswers: nextAnswers,
      questionCustomMode: false,
      questionCustomInput: "",
      questionCustomCursor: 0
    }
  }

  if (current.multi) {
    const selected = state.questionMultiSelected[current.id] || new Set()
    const values = [...selected]
      .map((index) => {
        const opt = (current.options || [])[index]
        return opt ? (opt.value || opt.label) : ""
      })
      .filter(Boolean)
    nextAnswers[current.id] = values.join(", ")
    return { ...state, questionAnswers: nextAnswers }
  }

  const option = (current.options || [])[state.questionOptionSelected]
  if (option) nextAnswers[current.id] = option.value || option.label
  return { ...state, questionAnswers: nextAnswers }
}

export function advanceQuestionState(state) {
  const questions = state.pendingQuestion?.questions || []
  if (state.questionIndex < questions.length - 1) {
    return {
      ...state,
      questionIndex: state.questionIndex + 1,
      questionOptionSelected: 0,
      questionCustomMode: false,
      questionCustomInput: "",
      questionCustomCursor: 0
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
