import test from "node:test"
import assert from "node:assert/strict"
import { createPromptQueue } from "../src/repl/prompt-queue.mjs"
import { createReplUiState } from "../src/repl/ui-state.mjs"

/**
 * 工具层的两种模态提示：权限审批与提问。
 *
 * 这一簇此前在 startTuiRepl 闭包里、**零测试** —— 而它管的是「一个 Promise 会不会
 * 永远悬着」：每一条提示背后都挂着一次没有 settle 的工具调用。少 resolve 一个，
 * 表现就是「有个后台任务卡住了，看不出为什么」，严重时进程不退出。
 */

const ESC = String.fromCharCode(27)

function harness() {
  const ui = createReplUiState()
  let renders = 0
  const queue = createPromptQueue({ ui, requestRender: () => { renders += 1 } })
  return { ui, queue, renders: () => renders }
}

/** 造一个「等着被回答」的权限请求，记录它拿到了什么。 */
function permissionRequest(label = "p") {
  const settled = []
  return {
    request: { tool: "write", pattern: `${label}.txt`, defaultAction: "deny", resolve: (d) => settled.push(d) },
    settled
  }
}

function questionRequest(questions, label = "q") {
  const settled = []
  return {
    request: { questions, resolve: (answers) => settled.push(answers) },
    settled,
    label
  }
}

// --- 权限队列 ---

test("the first permission shows immediately, the rest queue up", () => {
  // 并行子智能体会同时要审批。没有队列的话后到的会覆盖前一个，
  // 前一个的 Promise 永远等不到 resolve。
  const { ui, queue } = harness()
  const a = permissionRequest("a")
  const b = permissionRequest("b")
  queue.queuePermissionPrompt(a.request)
  queue.queuePermissionPrompt(b.request)
  assert.equal(ui.pendingPermission, a.request, "先到的先显示")
  assert.equal(ui.permissionQueue.length, 1, "后到的排队，不该覆盖")
})

test("answering one pulls the next in", () => {
  const { ui, queue } = harness()
  const a = permissionRequest("a")
  const b = permissionRequest("b")
  queue.queuePermissionPrompt(a.request)
  queue.queuePermissionPrompt(b.request)
  queue.resolvePermissionPrompt("allow_once")
  assert.deepEqual(a.settled, ["allow_once"])
  assert.equal(ui.pendingPermission, b.request, "队列里的下一个要顶上")
  queue.resolvePermissionPrompt("deny")
  assert.deepEqual(b.settled, ["deny"])
  assert.equal(ui.pendingPermission, null)
})

test("the highlighted choice starts at the request's own default", () => {
  const { ui, queue } = harness()
  queue.queuePermissionPrompt({ tool: "write", defaultAction: "deny", resolve: () => {} })
  const denyIndex = ui.permissionSelected
  queue.resolvePermissionPrompt("deny")
  queue.queuePermissionPrompt({ tool: "read", defaultAction: "allow_once", resolve: () => {} })
  assert.notEqual(ui.permissionSelected, denyIndex,
    "不同的默认动作应当预选不同的项 —— 否则默认值等于没传")
})

test("a throwing resolve does not wedge the queue", () => {
  // 一个调用方炸了不能把后面所有等待中的调用一起拖死
  const { ui, queue } = harness()
  queue.queuePermissionPrompt({ tool: "a", resolve: () => { throw new Error("boom") } })
  const next = permissionRequest("b")
  queue.queuePermissionPrompt(next.request)
  assert.doesNotThrow(() => queue.resolvePermissionPrompt("allow_once"))
  assert.equal(ui.pendingPermission, next.request, "下一个仍要顶上")
})

test("answering with nothing pending is a no-op", () => {
  const { queue } = harness()
  assert.doesNotThrow(() => queue.resolvePermissionPrompt("allow_once"))
})

// --- 提问 ---

test("question text is sanitized before it reaches the screen", () => {
  // 问题文本来自模型与工具，可能带终端控制序列
  const { ui, queue } = harness()
  queue.queueQuestionPrompt({
    questions: [{ id: "q1", text: `选哪个${ESC}[2J`, options: [{ label: "甲" }] }],
    resolve: () => {}
  })
  const text = ui.pendingQuestion.questions[0].text
  assert.doesNotMatch(text, new RegExp(ESC), "转义字符必须被消掉")
})

test("answering the last question resolves the whole request", () => {
  const { ui, queue } = harness()
  const q = questionRequest([{ id: "q1", text: "选哪个", options: [{ label: "甲" }, { label: "乙" }] }])
  queue.queueQuestionPrompt(q.request)
  ui.questionOptionSelected = 1
  queue.advanceOrSubmitQuestion()
  assert.equal(q.settled.length, 1, "只有一个问题，答完就该交卷")
  assert.equal(ui.pendingQuestion, null)
})

test("a multi-question request advances instead of submitting early", () => {
  const { ui, queue } = harness()
  const q = questionRequest([
    { id: "q1", text: "第一问", options: [{ label: "甲" }] },
    { id: "q2", text: "第二问", options: [{ label: "乙" }] }
  ])
  queue.queueQuestionPrompt(q.request)
  queue.advanceOrSubmitQuestion()
  assert.equal(q.settled.length, 0, "还有一问没答，不该提前交卷")
  assert.equal(ui.questionIndex, 1, "应当推进到下一问")
  queue.advanceOrSubmitQuestion()
  assert.equal(q.settled.length, 1)
})

test("the next queued question takes over without an empty screen in between", () => {
  const { ui, queue } = harness()
  const first = questionRequest([{ id: "a", text: "一", options: [{ label: "x" }] }])
  const second = questionRequest([{ id: "b", text: "二", options: [{ label: "y" }] }])
  queue.queueQuestionPrompt(first.request)
  queue.queueQuestionPrompt(second.request)
  assert.equal(ui.questionQueue.length, 1)
  queue.advanceOrSubmitQuestion()
  assert.equal(first.settled.length, 1)
  assert.ok(ui.pendingQuestion, "队列里还有就该直接接上，不要先回到空屏")
})

test("resolving resets every piece of question state", () => {
  const { ui, queue } = harness()
  queue.queueQuestionPrompt(questionRequest([{ id: "q1", text: "问", options: [{ label: "甲" }] }]).request)
  ui.questionCustomMode = true
  ui.questionCustomInput = "写了一半"
  ui.questionCustomCursor = 3
  ui.questionMultiSelected = { q1: new Set([0]) }
  queue.resolveQuestionPrompt()
  assert.equal(ui.questionCustomMode, false)
  assert.equal(ui.questionCustomInput, "", "残留的半截输入会串到下一个问题里")
  assert.equal(ui.questionCustomCursor, 0)
  assert.deepEqual(ui.questionMultiSelected, {})
  assert.equal(ui.questionIndex, 0)
})

// --- 自由文本输入 ---

test("free text is accepted only when the question is actually asking for it", () => {
  const { ui, queue } = harness()
  queue.queueQuestionPrompt(questionRequest([{ id: "q1", text: "问", options: [{ label: "甲" }] }]).request)
  assert.equal(queue.questionAcceptsTextInput(), false, "选项模式不收自由文本")
  assert.equal(queue.insertQuestionText("字"), false)
  assert.equal(ui.questionCustomInput, "")

  ui.questionCustomMode = true
  assert.equal(queue.questionAcceptsTextInput(), true)
  assert.equal(queue.insertQuestionText("字"), true)
  assert.equal(ui.questionCustomInput, "字")
})

test("a question with no options is free text from the start", () => {
  const { queue } = harness()
  queue.queueQuestionPrompt(questionRequest([{ id: "q1", text: "随便说", options: [] }]).request)
  assert.equal(queue.questionAcceptsTextInput(), true)
})

test("text is inserted at the cursor, not appended", () => {
  const { ui, queue } = harness()
  queue.queueQuestionPrompt(questionRequest([{ id: "q1", text: "问", options: [] }]).request)
  queue.insertQuestionText("abcd")
  ui.questionCustomCursor = 2
  queue.insertQuestionText("XY")
  assert.equal(ui.questionCustomInput, "abXYcd")
  assert.equal(ui.questionCustomCursor, 4, "光标要落在插入内容之后")
})

test("an out-of-range cursor is clamped rather than corrupting the text", () => {
  const { ui, queue } = harness()
  queue.queueQuestionPrompt(questionRequest([{ id: "q1", text: "问", options: [] }]).request)
  queue.insertQuestionText("abc")
  ui.questionCustomCursor = 999
  queue.insertQuestionText("Z")
  assert.equal(ui.questionCustomInput, "abcZ")
})

test("empty input is rejected without touching the buffer", () => {
  const { ui, queue } = harness()
  queue.queueQuestionPrompt(questionRequest([{ id: "q1", text: "问", options: [] }]).request)
  assert.equal(queue.insertQuestionText(""), false)
  assert.equal(queue.insertQuestionText(null), false)
  assert.equal(ui.questionCustomInput, "")
})

// --- 退出：每一个都必须 settle ---

test("exiting settles every pending prompt, fail-closed for permissions", () => {
  // 少结一个，等在那里的工具回合会在界面退出之后继续悬着，进程不退出
  const { ui, queue } = harness()
  const p1 = permissionRequest("a")
  const p2 = permissionRequest("b")
  const q1 = questionRequest([{ id: "x", text: "一", options: [{ label: "甲" }] }])
  const q2 = questionRequest([{ id: "y", text: "二", options: [{ label: "乙" }] }])
  queue.queuePermissionPrompt(p1.request)
  queue.queuePermissionPrompt(p2.request)
  queue.queueQuestionPrompt(q1.request)
  queue.queueQuestionPrompt(q2.request)
  assert.equal(queue.pendingCount(), 4)

  queue.settlePendingPromptsForExit()

  assert.deepEqual(p1.settled, ["deny"], "权限一律 fail closed")
  assert.deepEqual(p2.settled, ["deny"], "排队中的也要结掉")
  assert.equal(q1.settled.length, 1, "当前问题要给出明确答案")
  assert.equal(q2.settled.length, 1, "排队中的问题也要")
  assert.equal(queue.pendingCount(), 0)
  assert.equal(ui.pendingPermission, null)
  assert.equal(ui.pendingQuestion, null)
})

test("a throwing resolve during teardown does not strand the others", () => {
  const { queue } = harness()
  const good = permissionRequest("good")
  queue.queuePermissionPrompt({ tool: "bad", resolve: () => { throw new Error("boom") } })
  queue.queuePermissionPrompt(good.request)
  assert.doesNotThrow(() => queue.settlePendingPromptsForExit())
  assert.deepEqual(good.settled, ["deny"], "一个炸了，其余仍要结掉")
})

test("settling twice is harmless", () => {
  const { queue } = harness()
  const p = permissionRequest("a")
  queue.queuePermissionPrompt(p.request)
  queue.settlePendingPromptsForExit()
  assert.doesNotThrow(() => queue.settlePendingPromptsForExit())
  assert.deepEqual(p.settled, ["deny"], "不该被结第二次")
})
