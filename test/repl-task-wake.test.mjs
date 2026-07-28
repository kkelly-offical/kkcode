import test from "node:test"
import assert from "node:assert/strict"
import { createPromptOutbox } from "../src/repl/prompt-outbox.mjs"
import { createTaskWake } from "../src/repl/task-wake.mjs"

/**
 * 后台任务完成后的唤醒。
 *
 * 这里判定的是「现在能不能替用户按下 Enter」—— 全 REPL 唯一一处不经按键就开启
 * 新回合的路径。判错的代价不是少画一帧，是把他写了一半的话当成提问发出去，
 * 所以每个条件都单独钉一条。
 */

function wakeHarness({ ui: uiPatch = {}, listeners = null } = {}) {
  const ui = { input: "", inputCursor: 0, busy: false, ...uiPatch }
  const outbox = createPromptOutbox({ ui, showToast: () => {}, requestRender: () => {} })
  const sent = []
  const wake = createTaskWake({
    ui,
    outbox,
    listeners,
    submitOne: async (text) => { sent.push(text); ui.input = ""; ui.busy = false }
  })
  return { ui, outbox, wake, sent }
}

test("空闲且输入框是空的：唤醒真的把队列发出去", async () => {
  const { outbox, wake, sent } = wakeHarness()
  outbox.pushSystemPrompt("[后台任务完成] 索引重建")
  assert.equal(await wake.drain(), true)
  assert.deepEqual(sent, ["[后台任务完成] 索引重建"])
})

test("输入框里有草稿时绝不自动提交 —— 那会把他写了一半的话当成提问发出去", async () => {
  const { ui, outbox, wake, sent } = wakeHarness({ ui: { input: "我正在写的一句话" } })
  outbox.pushSystemPrompt("[后台任务完成] x")
  assert.equal(await wake.drain(), false)
  assert.deepEqual(sent, [])
  assert.equal(ui.input, "我正在写的一句话", "草稿必须原封不动")
  assert.equal(outbox.size(), 1, "消息留在队列里，等用户自己按 Enter 时一起走")
})

test("有模态在等人时不排：权限审批和提问都是先来后到", async () => {
  for (const modal of ["pendingPermission", "pendingQuestion"]) {
    const { outbox, wake, sent } = wakeHarness({ ui: { [modal]: { anything: true } } })
    outbox.pushSystemPrompt("[后台任务完成] x")
    assert.equal(await wake.drain(), false, `${modal} 挂起时不该自动提交`)
    assert.deepEqual(sent, [])
  }
})

test("回合还在跑就不走这条路 —— 那时后台结果已经进 steer 了", async () => {
  const { ui, outbox, wake, sent } = wakeHarness()
  ui.busy = true
  outbox.queue("排着的")
  assert.equal(await wake.drain(), false)
  assert.deepEqual(sent, [])
})

test("dispose 之后再也不自动开新回合", async () => {
  // 退出流程走完之后，迟到的后台任务终态仍会一路走到这里。
  const { outbox, wake, sent } = wakeHarness()
  outbox.pushSystemPrompt("[后台任务完成] 迟到的")
  wake.dispose()
  assert.equal(await wake.drain(), false)
  assert.deepEqual(sent, [])
  assert.equal(wake.isEnabled(), false)
})

test("传了登记本就自己把退出清理挂上去 —— 不留给调用方补一行", async () => {
  // 退出路径有正常与异常两条，各写一份清理清单正是 0.6.20 修掉的缺陷。
  const disposers = []
  const listeners = { add: (fn) => { disposers.push(fn); return fn } }
  const { outbox, wake, sent } = wakeHarness({ listeners })
  assert.equal(disposers.length, 1, "构造时就该登记好怎么摘")

  outbox.pushSystemPrompt("[后台任务完成] 迟到的")
  for (const dispose of disposers) dispose()
  assert.equal(await wake.drain(), false)
  assert.deepEqual(sent, [])
})

test("排干中途被 Esc 打断，剩下的就不发了", async () => {
  const ui = { input: "", inputCursor: 0, busy: false }
  const outbox = createPromptOutbox({ ui, showToast: () => {}, requestRender: () => {} })
  const sent = []
  const wake = createTaskWake({
    ui,
    outbox,
    submitOne: async (text) => { sent.push(text); ui.paused = true }
  })
  outbox.pushSystemPrompt("第一条")
  outbox.pushSystemPrompt("第二条")
  await wake.drain()
  assert.deepEqual(sent, ["第一条"], `按过 Esc 之后不该继续发，实际 ${JSON.stringify(sent)}`)
})

test("两次唤醒撞在一起不会把同一条发两遍", async () => {
  const ui = { input: "", inputCursor: 0, busy: false }
  const outbox = createPromptOutbox({ ui, showToast: () => {}, requestRender: () => {} })
  const sent = []
  let second = null
  const wake = createTaskWake({
    ui,
    outbox,
    submitOne: async (text) => {
      // 提交进行到一半时又来一个后台任务完成 —— 真实时序里这完全可能
      if (!second) second = wake.drain()
      sent.push(text)
    }
  })
  outbox.pushSystemPrompt("唯一的一条")
  await wake.drain()
  assert.equal(await second, false, "重入的那次应当直接退出")
  assert.deepEqual(sent, ["唯一的一条"])
})

