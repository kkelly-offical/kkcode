import test from "node:test"
import assert from "node:assert/strict"
import { createPromptOutbox, DEFAULT_MAX_QUEUED } from "../src/repl/prompt-outbox.mjs"

/**
 * 排队输入的回归网。
 *
 * 这里最容易写错的是**排干期间队列还在变**：中断后清空、或者用户又排了一条。
 * 一次性拷快照再遍历的实现能过掉大部分用例，却会在中断之后把剩下的照发不误 ——
 * 那正是用户按 Esc 想阻止的事。
 */

function harness({ maxQueued } = {}) {
  const ui = {}
  const toasts = []
  let renders = 0
  const outbox = createPromptOutbox({
    ui,
    showToast: (message, options) => toasts.push({ message, options }),
    requestRender: () => { renders++ },
    maxQueued
  })
  return { ui, toasts, outbox, renders: () => renders }
}

test("排一条会进队列，并且告诉用户排到第几个", () => {
  const { ui, toasts, outbox } = harness()
  assert.equal(outbox.queue("第一句"), true)
  assert.deepEqual(ui.queuedPrompts, ["第一句"])
  assert.match(toasts.at(-1).message, /已排队（1）/)
  outbox.queue("第二句")
  assert.match(toasts.at(-1).message, /已排队（2）/, `实际是 ${toasts.at(-1).message}`)
})

test("空白不占队列 —— 忙碌中误触回车不该排进一条空消息", () => {
  const { ui, outbox, toasts } = harness()
  assert.equal(outbox.queue("   \n  "), false)
  assert.equal(outbox.queue(""), false)
  assert.equal(outbox.queue(null), false)
  assert.deepEqual(ui.queuedPrompts, [])
  assert.deepEqual(toasts, [], "什么都没排，就不该弹提示")
})

test("首尾空白被去掉", () => {
  const { ui, outbox } = harness()
  outbox.queue("  带空白的一句  ")
  assert.deepEqual(ui.queuedPrompts, ["带空白的一句"])
})

test("到上限就拒绝并说清楚该怎么办", () => {
  const { ui, outbox, toasts } = harness({ maxQueued: 2 })
  outbox.queue("a"); outbox.queue("b")
  assert.equal(outbox.queue("c"), false, "第三条应当被拒")
  assert.deepEqual(ui.queuedPrompts, ["a", "b"], "被拒的不能混进队列")
  assert.match(toasts.at(-1).message, /已满/)
  assert.match(toasts.at(-1).message, /Esc/, "光说满了没用，要给出下一步")
  assert.equal(toasts.at(-1).options.tone, "warning")
})

test("默认上限是一个明确的数字，不是随手写的", () => {
  assert.equal(typeof DEFAULT_MAX_QUEUED, "number")
  assert.ok(DEFAULT_MAX_QUEUED >= 1)
})

test("排干按先进先出，一条一条交出去", async () => {
  const { outbox, ui } = harness()
  outbox.queue("一"); outbox.queue("二"); outbox.queue("三")
  const sent = []
  await outbox.drain(async (text) => { sent.push(text) })
  assert.deepEqual(sent, ["一", "二", "三"])
  assert.deepEqual(ui.queuedPrompts, [], "排干之后队列必须是空的")
})

test("排干期间用户又排了一条，它也会被发出去", async () => {
  // 回合结束到下一条发出之间有真实的时间窗，用户完全可能在那时又敲了一句
  const { outbox } = harness()
  outbox.queue("一")
  const sent = []
  await outbox.drain(async (text) => {
    sent.push(text)
    if (text === "一") outbox.queue("追加的")
  })
  assert.deepEqual(sent, ["一", "追加的"], "排干时应当重新读队列，而不是遍历一份快照")
})

test("排干期间被清空，剩下的就不发了 —— 这正是 Esc 的意图", async () => {
  // 拷快照再遍历的实现能过掉上面所有用例，却会在这里把用户已经喊停的消息照发不误
  const { outbox } = harness()
  outbox.queue("一"); outbox.queue("二"); outbox.queue("三")
  const sent = []
  await outbox.drain(async (text) => {
    sent.push(text)
    if (text === "一") outbox.clear()
  })
  assert.deepEqual(sent, ["一"], `中断后不该继续发，实际发了 ${JSON.stringify(sent)}`)
})

test("清空会说出丢了几条 —— 悄悄丢掉用户会以为还在排队", () => {
  const { outbox, toasts } = harness()
  outbox.queue("一"); outbox.queue("二")
  assert.equal(outbox.clear(), 2)
  assert.match(toasts.at(-1).message, /丢弃 2 条/)
  assert.equal(toasts.at(-1).options.tone, "warning")
})

test("队列本来就空时，清空不弹任何东西", () => {
  const { outbox, toasts } = harness()
  assert.equal(outbox.clear(), 0)
  assert.deepEqual(toasts, [], "没东西可丢就别打扰用户")
})

test("空队列排干是一个空操作，不会调 submitOne", async () => {
  const { outbox } = harness()
  let calls = 0
  await outbox.drain(async () => { calls++ })
  assert.equal(calls, 0)
})

test("队列就存在 ui 上 —— 帧直接读它，没有第二份副本", () => {
  const { ui, outbox } = harness()
  outbox.queue("一")
  assert.equal(ui.queuedPrompts.length, outbox.size())
  assert.deepEqual(outbox.list(), ui.queuedPrompts)
  outbox.list().push("外面改不动内部")
  assert.equal(ui.queuedPrompts.length, 1, "list() 要交出拷贝，不能把内部数组递出去")
})

test("已有的 queuedPrompts 不会被构造函数抹掉", () => {
  // /resume 之类的路径可能先把状态摆好再建 outbox
  const ui = { queuedPrompts: ["之前排的"] }
  const outbox = createPromptOutbox({ ui, showToast: () => {}, requestRender: () => {} })
  assert.deepEqual(outbox.list(), ["之前排的"])
})

test("每次入队与出队都请求重绘，否则计数不会更新", async () => {
  const h = harness()
  const before = h.renders()
  h.outbox.queue("一")
  assert.ok(h.renders() > before, "入队要重绘")
  const mid = h.renders()
  await h.outbox.drain(async () => {})
  assert.ok(h.renders() > mid, "出队也要重绘")
})
