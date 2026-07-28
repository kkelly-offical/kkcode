import test from "node:test"
import assert from "node:assert/strict"
import { createAfkAutoSkip } from "../src/repl/afk-auto-skip.mjs"
import { createPromptQueue } from "../src/repl/prompt-queue.mjs"
import { createReplUiState } from "../src/repl/ui-state.mjs"

/**
 * AFK 提问打发（0.8.1）。
 *
 * 计时器全部注入 —— 不真等十分钟，fire 由测试手动触发。注入的句柄包成
 * `{ id }` 对象且**不带 unref**：实现会对句柄调 `?.unref?.()`，注入裸
 * setTimeout 返回值会被它静默消解（Node 22 那一课的形状）。
 */

function fakeClock() {
  const timers = new Map()
  let seq = 0
  return {
    timers,
    setTimer: (fn, ms) => {
      const id = ++seq
      timers.set(id, { fn, ms })
      return { id }
    },
    clearTimer: (handle) => { if (handle) timers.delete(handle.id) },
    fire: () => {
      const pending = [...timers.values()]
      timers.clear()
      for (const t of pending) t.fn()
    },
    armedCount: () => timers.size
  }
}

function harness({ timeoutMs = 600_000, pendingQuestion = { questions: [] } } = {}) {
  const clock = fakeClock()
  const ui = { pendingQuestion, pendingPermission: null }
  const calls = []
  const afk = createAfkAutoSkip({
    ui,
    timeoutMs,
    resolveQuestionPrompt: () => { calls.push("resolve"); ui.pendingQuestion = null },
    showToast: (msg) => calls.push(`toast(${msg})`),
    appendLog: (line) => calls.push(`log(${line})`),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  })
  return { clock, ui, calls, afk }
}

test("提问出现起表，超时按「跳过」结掉并上屏说明", () => {
  const { clock, calls, afk } = harness()
  afk.questionShown()
  assert.equal(clock.armedCount(), 1)
  clock.fire()
  assert.ok(calls.includes("resolve"), "超时必须走 resolveQuestionPrompt 的既有路径")
  assert.ok(calls.some((c) => c.startsWith("log(")), "用户回来得知道发生过什么")
  assert.ok(calls.some((c) => c.startsWith("toast(")))
})

test("任何按键都把表拨回起点 —— 盯着选项想十分钟的人不会被打发", () => {
  const { clock, afk } = harness()
  afk.questionShown()
  const [first] = clock.timers.keys()
  afk.noteActivity()
  assert.equal(clock.armedCount(), 1, "重置 = 旧表清掉、新表起上")
  const [second] = clock.timers.keys()
  assert.notEqual(first, second, "必须是一只新表，不是让旧表继续走")
})

test("timeoutMs 为 0 时整个功能不存在", () => {
  const { clock, calls, afk } = harness({ timeoutMs: 0 })
  afk.questionShown()
  afk.noteActivity()
  assert.equal(clock.armedCount(), 0, "关掉的功能一只表都不该起")
  clock.fire()
  assert.deepEqual(calls, [])
})

test("表响时提问已经被人答掉 → 什么都不做", () => {
  const { clock, ui, calls, afk } = harness()
  afk.questionShown()
  ui.pendingQuestion = null   // 用户在最后一刻答了
  clock.fire()
  assert.deepEqual(calls, [], "对着空气 resolve 会把下一个提问误伤")
})

test("权限审批不起表 —— 安全决策无论挂多久都等人", () => {
  const { clock, ui, afk } = harness({ pendingQuestion: null })
  ui.pendingPermission = { tool: "bash", resolve: () => {} }
  afk.questionShown()
  afk.noteActivity()
  assert.equal(clock.armedCount(), 0, "没有提问就没有表，审批在场也一样")
})

test("dispose 之后迟到的 fire 是空操作", () => {
  const { clock, calls, afk } = harness()
  afk.questionShown()
  const pending = [...clock.timers.values()]
  afk.dispose()
  for (const t of pending) t.fn()   // 模拟已入队的回调在 dispose 后才跑
  assert.deepEqual(calls, [])
})

test("prompt-queue 集成：提问激活起表、结掉收表、下一个接着起", () => {
  const clock = fakeClock()
  const ui = createReplUiState()
  const resolved = []
  const queue = []
  // afk 与 prompts 互相引用 —— 与 repl.mjs 相同的接线形状（箭头延迟取值）
  let prompts = null
  const afk = createAfkAutoSkip({
    ui,
    timeoutMs: 1000,
    resolveQuestionPrompt: () => prompts.resolveQuestionPrompt(),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  })
  prompts = createPromptQueue({ ui, requestRender: () => {}, afk })

  prompts.queueQuestionPrompt({ questions: [{ id: "a", text: "第一问" }], resolve: (a) => resolved.push(a) })
  prompts.queueQuestionPrompt({ questions: [{ id: "b", text: "第二问" }], resolve: (a) => resolved.push(a) })
  assert.equal(clock.armedCount(), 1, "第一问激活即起表")

  clock.fire()
  assert.equal(resolved.length, 1, "第一问被打发")
  assert.equal(resolved[0].a, "(skipped)", "打发 = 跳过语义，不编造答案")
  assert.equal(clock.armedCount(), 1, "队列里的第二问接着起表 —— 否则挂机只解一题")

  clock.fire()
  assert.equal(resolved.length, 2, "第二问同样被打发")
  assert.equal(clock.armedCount(), 0, "没有提问了，表收干净")
})

test("settlePendingPromptsForExit 收表 —— 退出后不能再有回调去碰已拆除的界面", () => {
  const clock = fakeClock()
  const ui = createReplUiState()
  let prompts = null
  const afk = createAfkAutoSkip({
    ui, timeoutMs: 1000,
    resolveQuestionPrompt: () => prompts.resolveQuestionPrompt(),
    setTimer: clock.setTimer, clearTimer: clock.clearTimer
  })
  prompts = createPromptQueue({ ui, requestRender: () => {}, afk })
  prompts.queueQuestionPrompt({ questions: [{ id: "a" }], resolve: () => {} })
  assert.equal(clock.armedCount(), 1)
  prompts.settlePendingPromptsForExit()
  assert.equal(clock.armedCount(), 0)
})

test("不接 afk 的 prompt-queue 零 AFK 行为 —— 行模式与既有测试的缺省路径", () => {
  const ui = createReplUiState()
  const prompts = createPromptQueue({ ui, requestRender: () => {} })
  prompts.queueQuestionPrompt({ questions: [{ id: "a" }], resolve: () => {} })
  assert.ok(ui.pendingQuestion, "一切照旧，没有任何计时器介入")
})
