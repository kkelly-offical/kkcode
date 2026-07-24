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
