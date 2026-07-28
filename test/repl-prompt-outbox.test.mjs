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

function harness({ maxQueued, wakeIdle } = {}) {
  const ui = {}
  const toasts = []
  let renders = 0
  const outbox = createPromptOutbox({
    ui,
    showToast: (message, options) => toasts.push({ message, options }),
    requestRender: () => { renders++ },
    maxQueued,
    wakeIdle
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

test("再按一次 Enter：最后排队的那条升级为插话，从队列移入 steer", () => {
  const { ui, outbox, toasts } = harness()
  outbox.queue("早排的")
  outbox.queue("刚敲的")
  const promoted = outbox.promoteLastToSteer()
  assert.equal(promoted, "刚敲的", "升级的是最后一条 —— 用户此刻想让模型立刻看到的是刚敲的那句")
  assert.deepEqual(ui.queuedPrompts, ["早排的"], "早排的留在队列里照常等回合结束")
  assert.deepEqual(ui.steerPrompts, ["刚敲的"])
  assert.match(toasts.at(-1).message, /插话/)
})

test("队列为空时升级是空操作 —— 空输入框上的 Enter 不该有副作用", () => {
  const { ui, outbox, toasts } = harness()
  assert.equal(outbox.promoteLastToSteer(), null)
  assert.deepEqual(ui.steerPrompts, [])
  assert.deepEqual(toasts, [], "没升级任何东西就别弹提示")
})

test("takeSteer 取走全部并清空 —— 取走即负责送达，不留副本", () => {
  const { ui, outbox } = harness()
  outbox.queue("a"); outbox.promoteLastToSteer()
  outbox.queue("b"); outbox.promoteLastToSteer()
  assert.deepEqual(outbox.takeSteer(), ["a", "b"], "按升级顺序")
  assert.deepEqual(ui.steerPrompts, [], "取走后必须清空 —— 否则同一条会被注入两次")
  assert.deepEqual(outbox.takeSteer(), [], "再取是空的")
})

test("clear 连 steer 一起丢，且计数包含它们", () => {
  const { ui, outbox, toasts } = harness()
  outbox.queue("a"); outbox.promoteLastToSteer()
  outbox.queue("b")
  assert.equal(outbox.clear(), 2, "1 条排队 + 1 条插话")
  assert.deepEqual(ui.steerPrompts, [])
  assert.match(toasts.at(-1).message, /丢弃 2 条/)
})

test("steerSize 与 ui.steerPrompts 同源", () => {
  const { ui, outbox } = harness()
  outbox.queue("x"); outbox.promoteLastToSteer()
  assert.equal(outbox.steerSize(), 1)
  assert.equal(ui.steerPrompts.length, 1)
})

/**
 * 后台任务完成后的回送（0.8.0）。
 *
 * 与用户排队走的是同两条通道，但时机判定完全不同 —— 用户排的消息等回合结束
 * 是他自己的选择，后台结果等不得：主代理正在做的事很可能就依赖它。
 */

test("回合进行中：后台结果直接进插话，不去队列后面排着", () => {
  const { ui, outbox, toasts } = harness()
  ui.busy = true
  outbox.queue("用户排的")
  assert.equal(outbox.pushSystemPrompt("[后台任务完成] 索引重建"), "steer")
  assert.deepEqual(ui.steerPrompts, ["[后台任务完成] 索引重建"])
  assert.deepEqual(ui.queuedPrompts, ["用户排的"], "不得挤进用户的队列")
  assert.match(toasts.at(-1).message, /后台任务完成/)
})

test("空闲：进队列并请求一次排干 —— 排完没人来取就等于没唤醒", () => {
  let wakes = 0
  const { ui, outbox } = harness({ wakeIdle: () => { wakes++ } })
  ui.busy = false
  assert.equal(outbox.pushSystemPrompt("[后台任务完成] 索引重建"), "queued")
  assert.deepEqual(ui.queuedPrompts, ["[后台任务完成] 索引重建"])
  assert.deepEqual(ui.steerPrompts, [])
  assert.equal(wakes, 1)
})

test("没接 wakeIdle 就零唤醒行为 —— 自动开新回合是副作用，不能默认发生", () => {
  // 行模式、子代理、测试宿主都不传 wakeIdle。这条钉住缺省路径：消息照排，
  // 但绝不会有人替用户按下 Enter。
  const { ui, outbox } = harness()
  assert.equal(outbox.pushSystemPrompt("[后台任务完成] x"), "queued")
  assert.deepEqual(ui.queuedPrompts, ["[后台任务完成] x"])
})

test("空文本什么都不做，也不会白唤醒一次", () => {
  let wakes = 0
  const { ui, outbox, toasts } = harness({ wakeIdle: () => { wakes++ } })
  assert.equal(outbox.pushSystemPrompt("   "), null)
  assert.equal(outbox.pushSystemPrompt(null), null)
  assert.deepEqual(ui.queuedPrompts, [])
  assert.deepEqual(toasts, [])
  assert.equal(wakes, 0)
})

test("队列排满时说清楚结果去哪儿找，而不是悄悄丢掉", () => {
  let wakes = 0
  const { ui, outbox, toasts } = harness({ maxQueued: 1, wakeIdle: () => { wakes++ } })
  outbox.queue("用户排的")
  assert.equal(outbox.pushSystemPrompt("[后台任务完成] x"), null)
  assert.deepEqual(ui.queuedPrompts, ["用户排的"])
  assert.match(toasts.at(-1).message, /background/)
  assert.equal(toasts.at(-1).options.tone, "warning")
  assert.equal(wakes, 0, "没排进去就不该请求排干")
})

// --- 滞留 steer 的回收（0.8.0 e2e 抓到的时序） ---

test("落在末 step 之后的后台结果，回合结束的排干会接着送达", async () => {
  // 时序：回合进行中 settle 到达 → 进 steer；但那已是最后一个 step，
  // 回合内再无注入点 → 滞留。回合结束的 drain 必须把它回收发出去，
  // 否则「自动唤醒」在这个窗口静默失效，结果要等用户下次随便说句话才捎到。
  const { ui, outbox } = harness()
  ui.busy = true
  assert.equal(outbox.pushSystemPrompt("[后台任务完成] 秋诗已写好"), "steer")
  ui.busy = false   // 回合结束，steer 里还躺着一条
  const sent = []
  await outbox.drain(async (text) => sent.push(text))
  assert.deepEqual(sent, ["[后台任务完成] 秋诗已写好"])
  assert.equal(ui.steerPrompts.length, 0)
  assert.equal(ui.queuedPrompts.length, 0)
})

test("排干期间跑掉的回合又滞留了一条 —— 同一次 drain 连它一起发完", async () => {
  const { ui, outbox } = harness()
  outbox.queue("第一条")
  const sent = []
  await outbox.drain(async (text) => {
    sent.push(text)
    if (text === "第一条") {
      // 模拟：这条 submit 跑出的回合期间，后台任务在末 step 之后落地
      ui.busy = true
      outbox.pushSystemPrompt("迟到的结果")
      ui.busy = false
    }
  })
  assert.deepEqual(sent, ["第一条", "迟到的结果"])
})

test("回合仍在进行时 reclaim 不动 steer —— 那是 takeSteer 的地盘", () => {
  const { ui, outbox } = harness()
  ui.busy = true
  outbox.pushSystemPrompt("插话中")
  assert.equal(outbox.reclaimStranded(), 0, "busy 时回收是空操作")
  assert.equal(ui.steerPrompts.length, 1)
})

test("队列满时回收只搬得下的，剩下的留在 steer 不丢", () => {
  const { ui, outbox } = harness({ maxQueued: 2 })
  ui.busy = true
  outbox.pushSystemPrompt("a"); outbox.pushSystemPrompt("b"); outbox.pushSystemPrompt("c")
  ui.busy = false
  assert.equal(outbox.reclaimStranded(), 2)
  assert.deepEqual(ui.queuedPrompts, ["a", "b"])
  assert.deepEqual(ui.steerPrompts, ["c"], "搬不下的留着 —— 下一个回合的 step 1 仍会取走")
})
