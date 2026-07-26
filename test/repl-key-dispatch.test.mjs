import test from "node:test"
import assert from "node:assert/strict"
import { createKeyDispatcher, on } from "../src/repl/key-dispatch.mjs"

/**
 * 按键优先级此前的唯一载体是「哪个 if 写在 685 行里的前面」。没有任何东西能表达、
 * 检查或测试它 —— 有人为了别的原因挪一下代码块，规则就悄悄破了。
 *
 * 这些用例断言的正是那些规则本身。
 */

function ctx(patch = {}) {
  return { key: {}, str: "", ui: {}, ...patch }
}

function trace() {
  const calls = []
  return {
    calls,
    handler: (id, when) => ({ id, when, run: () => { calls.push(id) } })
  }
}

test("the first matching handler wins and dispatch stops", () => {
  const t = trace()
  const d = createKeyDispatcher({
    scopes: [{
      id: "global",
      handlers: [
        t.handler("first", on.key("up")),
        t.handler("second", on.key("up"))
      ]
    }]
  })
  return d.dispatchKey(ctx({ key: { name: "up" } })).then((r) => {
    assert.equal(r.handler, "first")
    assert.deepEqual(t.calls, ["first"], "第二个同条件的处理器不该也跑")
  })
})

test("an unmatched key in a non-modal scope falls through", async () => {
  const t = trace()
  const d = createKeyDispatcher({
    scopes: [
      { id: "a", handlers: [t.handler("onlyUp", on.key("up"))] },
      { id: "b", handlers: [t.handler("onlyDown", on.key("down"))] }
    ]
  })
  const r = await d.dispatchKey(ctx({ key: { name: "down" } }))
  assert.equal(r.scope, "b")
  assert.deepEqual(t.calls, ["onlyDown"])
})

test("nothing matching at all is reported as unhandled", async () => {
  const d = createKeyDispatcher({
    scopes: [{ id: "a", handlers: [{ id: "x", when: on.key("up"), run: () => {} }] }]
  })
  const r = await d.dispatchKey(ctx({ key: { name: "tab" } }))
  assert.equal(r.handled, false)
})

test("a modal scope swallows keys it does not handle", async () => {
  // 这是原来那种「整块包住、末尾一个裸 return」的语义。浮层开着时按 `a`
  // 不该悄悄改输入框内容。
  const t = trace()
  const d = createKeyDispatcher({
    scopes: [
      {
        id: "infoPanel",
        active: (c) => Boolean(c.ui.infoPanel),
        modal: true,
        handlers: [t.handler("scrollUp", on.key("up"))]
      },
      { id: "editor", handlers: [t.handler("insert", on.printable)] }
    ]
  })

  const swallowed = await d.dispatchKey(ctx({ ui: { infoPanel: {} }, key: {}, str: "a" }))
  assert.equal(swallowed.handled, true)
  assert.equal(swallowed.swallowed, true)
  assert.equal(swallowed.scope, "infoPanel")
  assert.deepEqual(t.calls, [], "被吞掉的按键不该触发任何处理器")

  const passed = await d.dispatchKey(ctx({ ui: {}, key: {}, str: "a" }))
  assert.equal(passed.handler, "insert", "浮层关闭后同一个键应落到编辑器")
})

test("an inactive scope is skipped entirely, modal or not", async () => {
  const t = trace()
  const d = createKeyDispatcher({
    scopes: [
      { id: "modal", active: () => false, modal: true, handlers: [t.handler("never", on.always)] },
      { id: "global", handlers: [t.handler("reached", on.always)] }
    ]
  })
  const r = await d.dispatchKey(ctx({ key: { name: "x" } }))
  assert.equal(r.handler, "reached", "未激活的模态作用域不该吞键")
})

// --- 真实的优先级规则 ---

test("an open info panel owns the arrow keys, not input history", async () => {
  // 规则原文：「信息浮层排在所有浮层之前：它是模态的，打开时应吃掉导航键，
  // 否则 ↑↓ 会同时滚浮层和翻输入历史。」
  const t = trace()
  const d = createKeyDispatcher({
    scopes: [
      {
        id: "infoPanel",
        active: (c) => Boolean(c.ui.infoPanel),
        modal: true,
        handlers: [t.handler("scroll", on.anyKey("up", "down"))]
      },
      { id: "editor", handlers: [t.handler("history", on.anyKey("up", "down"))] }
    ]
  })
  const withPanel = await d.dispatchKey(ctx({ ui: { infoPanel: {} }, key: { name: "up" } }))
  assert.equal(withPanel.handler, "scroll")
  const withoutPanel = await d.dispatchKey(ctx({ ui: {}, key: { name: "up" } }))
  assert.equal(withoutPanel.handler, "history")
})

test("a visible selection owns Ctrl+C, an idle prompt keeps interrupt", async () => {
  // 规则原文：「A visible selection owns Ctrl+C. With no selection, Ctrl+C keeps
  // its established interrupt/exit behavior.」
  const t = trace()
  const d = createKeyDispatcher({
    scopes: [{
      id: "global",
      handlers: [
        t.handler("copyMouseSelection", (c) => c.key.ctrl && c.key.name === "c" && Boolean(c.ui.mouseSelection)),
        t.handler("copyInputSelection", (c) => c.key.ctrl && c.key.name === "c" && Boolean(c.ui.inputSelection)),
        t.handler("interrupt", on.ctrl("c"))
      ]
    }]
  })
  assert.equal((await d.dispatchKey(ctx({ ui: { mouseSelection: {} }, key: { ctrl: true, name: "c" } }))).handler,
    "copyMouseSelection")
  assert.equal((await d.dispatchKey(ctx({ ui: { inputSelection: {} }, key: { ctrl: true, name: "c" } }))).handler,
    "copyInputSelection")
  assert.equal((await d.dispatchKey(ctx({ ui: {}, key: { ctrl: true, name: "c" } }))).handler,
    "interrupt")
})

test("describeOrder exposes the precedence as data", () => {
  const d = createKeyDispatcher({
    scopes: [
      { id: "infoPanel", handlers: [{ id: "scroll", when: on.always, run: () => {} }] },
      { id: "editor", handlers: [{ id: "history", when: on.always, run: () => {} }] }
    ]
  })
  const order = d.describeOrder()
  assert.deepEqual(order, ["infoPanel.scroll", "editor.history"])
  assert.ok(order.indexOf("infoPanel.scroll") < order.indexOf("editor.history"),
    "优先级现在是可断言的数据，不再是「哪个 if 写在前面」")
})

test("async handlers are awaited", async () => {
  const order = []
  const d = createKeyDispatcher({
    scopes: [{
      id: "a",
      handlers: [{
        id: "slow",
        when: on.always,
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          order.push("done")
        }
      }]
    }]
  })
  await d.dispatchKey(ctx({ key: { name: "x" } }))
  assert.deepEqual(order, ["done"], "提交这类处理器是异步的，必须 await 完再返回")
})

// --- 配置错误应当立刻报错，而不是静默失效 ---

test("a handler without an id is rejected at construction", () => {
  assert.throws(() => createKeyDispatcher({
    scopes: [{ id: "a", handlers: [{ when: on.always, run: () => {} }] }]
  }), /缺 id/)
})

test("a scope without an id is rejected at construction", () => {
  assert.throws(() => createKeyDispatcher({
    scopes: [{ handlers: [] }]
  }), /都要有 id/)
})

test("a handler without a run is rejected at construction", () => {
  assert.throws(() => createKeyDispatcher({
    scopes: [{ id: "a", handlers: [{ id: "x", when: on.always }] }]
  }), /缺 run/)
})

// --- 谓词 ---

test("the predicates match what the old if-chain matched", () => {
  assert.equal(on.ctrl("c")(ctx({ key: { ctrl: true, name: "c" } })), true)
  assert.equal(on.ctrl("c")(ctx({ key: { name: "c" } })), false, "不带 ctrl 不算")
  assert.equal(on.key("up")(ctx({ key: { name: "up" } })), true)
  assert.equal(on.anyKey("up", "down")(ctx({ key: { name: "down" } })), true)
  assert.equal(on.printable(ctx({ str: "a", key: {} })), true)
  assert.equal(on.printable(ctx({ str: "a", key: { ctrl: true } })), false, "Ctrl+A 不是可打印输入")
  assert.equal(on.printable(ctx({ str: "", key: {} })), false)
  assert.equal(on.printable(ctx({ str: "中", key: {} })), true, "中文输入必须算可打印")
})
