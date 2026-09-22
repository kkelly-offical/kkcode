import test from "node:test"
import assert from "node:assert/strict"
import { handleProviderLinePick } from "../src/repl/provider-line-pick.mjs"

/**
 * 行模式 provider 编号选择的拦截语义（抽自 repl.mjs processInputLine）。
 * 关键边界：`/` 开头的输入必须放行给命令分发，而不是被当成 provider 名。
 */

function harness({ list = ["test", "other"], input = "", current = "test" } = {}) {
  const printed = []
  const calls = []
  const state = { providerType: current }
  return {
    printed,
    calls,
    run: () => handleProviderLinePick({
      providerPicker: list,
      input,
      state,
      print: (text) => printed.push(String(text)),
      setProviderPicker: (value) => calls.push(`setPicker(${value})`),
      switchActiveProvider: async (name) => {
        calls.push(`switch(${name})`)
        state.providerType = name
      }
    }),
    state
  }
}

test("no active picker means the input passes through untouched", async () => {
  const result = await handleProviderLinePick({ providerPicker: null, input: "1" })
  assert.equal(result.handled, false)
})

test("a number picks by 1-based index", async () => {
  const h = harness({ input: "2" })
  const result = await h.run()
  assert.equal(result.handled, true)
  assert.deepEqual(h.calls, ["setPicker(null)", "switch(other)"])
})

test("a name picks by exact match", async () => {
  const h = harness({ input: "other" })
  await h.run()
  assert.equal(h.state.providerType, "other")
})

test("a slash command exits the pick mode and falls through to dispatch", async () => {
  const h = harness({ input: "/help" })
  const result = await h.run()
  assert.equal(result.handled, false, "命令不该被选择态吃掉")
  assert.deepEqual(h.calls, ["setPicker(null)"])
  assert.ok(h.printed.some((line) => line.includes("已退出")))
})

test("empty input cancels; unknown names and the current provider report in place", async () => {
  const empty = harness({ input: "" })
  await empty.run()
  assert.ok(empty.printed.some((line) => line.includes("已取消")))

  const unknown = harness({ input: "nope" })
  const unknownResult = await unknown.run()
  assert.equal(unknownResult.handled, true)
  assert.ok(unknown.printed.some((line) => line.includes("找不到 provider")))
  assert.equal(unknown.calls.filter((c) => c.startsWith("switch")).length, 0)

  const same = harness({ input: "test" })
  await same.run()
  assert.ok(same.printed.some((line) => line.includes("已经是当前 provider")))
})
