import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { clearFileReadState, getFileReadState, markFileRead, extractTrackedView } from "../src/tool/file-read-state.mjs"

beforeEach(() => {
  clearFileReadState()
})

test("file read state normalizes equivalent paths", () => {
  markFileRead("./src/../src/example.js", {
    content: "const x = 1\n",
    timestamp: 123,
    isPartialView: false
  })

  const state = getFileReadState("src/example.js")
  assert.ok(state)
  assert.equal(state.content, "const x = 1\n")
  assert.equal(state.timestamp, 123)
  assert.equal(state.isPartialView, false)
})

test("extractTrackedView returns matching slice for partial reads", () => {
  const state = {
    content: "line2\nline3",
    timestamp: 10,
    offset: 2,
    limit: 2,
    isPartialView: true
  }

  const view = extractTrackedView("line1\nline2\nline3\nline4", state)
  assert.equal(view, "line2\nline3")
})
