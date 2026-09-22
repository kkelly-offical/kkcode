import test from "node:test"
import assert from "node:assert/strict"
import {
  createTranscriptModel,
  renderTranscriptItems
} from "../src/ui/transcript-model.mjs"

test("structured transcript blocks are collapsed by default and toggle in place", () => {
  let clock = 100
  const model = createTranscriptModel({ now: () => clock })
  const id = model.appendLog({
    kind: "tool",
    summary: "Edit src/app.mjs",
    details: ["    - old", "    + new"],
    collapsible: true
  })

  assert.equal(model.getItems().length, 1)
  assert.equal(model.getItem(id).expanded, false)
  assert.deepEqual(
    model.render().map((line) => line.text),
    ["▸ Edit src/app.mjs"]
  )

  clock = 125
  model.toggleLog(id)
  const expanded = model.render()
  assert.deepEqual(
    expanded.map((line) => line.text),
    ["▾ Edit src/app.mjs", "    - old", "    + new"]
  )
  assert.ok(expanded.every((line) => line.itemId === id))
  assert.ok(expanded.every((line) => line.action === "toggle"))

  clock = 150
  model.updateLog(id, { status: "completed", summary: "Edit complete" })
  assert.equal(model.getItem(id).id, id)
  assert.equal(model.getItem(id).createdAt, 100)
  assert.equal(model.getItem(id).updatedAt, 150)
  assert.deepEqual(model.getItem(id).details, ["    - old", "    + new"])
})

test("transcript model retains legacy strings and enforces its item bound", () => {
  const model = createTranscriptModel({ maxItems: 2 })
  model.appendLog("one")
  model.appendLog("two")
  model.appendLog("three")

  assert.deepEqual(model.getItems().map((item) => item.summary), ["two", "three"])
  assert.deepEqual(model.render().map((line) => line.text), ["two", "three"])
})

test("renderTranscriptItems exposes stable clickable line metadata", () => {
  const lines = renderTranscriptItems([{
    id: "thinking-1",
    kind: "thinking",
    summary: "Thinking 3.2s",
    details: ["private reasoning preview"],
    expanded: true
  }])

  assert.equal(lines.length, 2)
  assert.equal(lines[0].section, "summary")
  assert.equal(lines[1].section, "detail")
  assert.ok(lines.every((line) => line.itemId === "thinking-1"))
})

test("system hints render with a muted gutter, distinct from conversation lines", () => {
  const model = createTranscriptModel()
  model.appendLog({ kind: "user", summary: "帮我改个文件" })
  model.appendLog({ kind: "system", summary: "已合并补充需求，从头重新规划" })
  model.appendLog({ kind: "assistant", summary: "好的" })

  const lines = model.render()
  assert.equal(lines.length, 3)
  assert.match(lines[1].text, /^· /, "系统提示有固定 gutter，与对话行区分开")
  assert.ok(!lines[0].text.startsWith("· "), "用户消息不带提示 gutter")
  assert.ok(!lines[2].text.startsWith("· "), "助手回复不带提示 gutter")
  assert.equal(lines[1].kind, "system")
})

test("a system hint with an explicit tone is not dimmed away", () => {
  // tone=warn 的提示（比如待确认的路由提问）需要保住可读性
  const model = createTranscriptModel()
  model.appendLog({ kind: "system", summary: "⚠ 确认一下", tone: "warn" })
  model.appendLog({ kind: "system", summary: "普通提示" })
  const [warned, plain] = model.render()
  assert.match(warned.text, /⚠ 确认一下/)
  assert.match(plain.text, /普通提示/)
})
