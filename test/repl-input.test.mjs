import test from "node:test"
import assert from "node:assert/strict"
import { collectInput, resolveHistoryNavigation, shouldApplySuggestionOnEnter } from "../src/repl/input-engine.mjs"

function mockRl(answers) {
  let i = 0
  return {
    question() {
      return Promise.resolve(answers[i++] ?? "")
    }
  }
}

test("collectInput: single line returns trimmed text", async () => {
  const rl = mockRl(["hello world"])
  const result = await collectInput(rl, "> ")
  assert.equal(result, "hello world")
})

test("collectInput: empty input returns empty string", async () => {
  const rl = mockRl(["  "])
  const result = await collectInput(rl, "> ")
  assert.equal(result, "")
})

test("collectInput: backslash continuation joins lines", async () => {
  const rl = mockRl(["first line\\", "second line\\", "third line"])
  const result = await collectInput(rl, "> ")
  assert.equal(result, "first line\nsecond line\nthird line")
})

test("collectInput: triple-quote block mode collects until closing quotes", async () => {
  const rl = mockRl(['"""', "line one", "line two", '"""'])
  const result = await collectInput(rl, "> ")
  assert.equal(result, "line one\nline two")
})

test("collectInput: triple-quote inline start collects rest", async () => {
  const rl = mockRl(['"""inline start', "more text", '"""'])
  const result = await collectInput(rl, "> ")
  assert.equal(result, "inline start\nmore text")
})

test("collectInput: single backslash continuation with one extra line", async () => {
  const rl = mockRl(["hello\\", "world"])
  const result = await collectInput(rl, "> ")
  assert.equal(result, "hello\nworld")
})

test("resolveHistoryNavigation moves up through history", () => {
  const result = resolveHistoryNavigation(["one", "two", "three"], 3, "up")
  assert.deepEqual(result, { historyIndex: 2, value: "three", changed: true })
})

test("resolveHistoryNavigation moves down to blank after latest history item", () => {
  const result = resolveHistoryNavigation(["one", "two"], 1, "down")
  assert.deepEqual(result, { historyIndex: 2, value: "", changed: true })
})

test("shouldApplySuggestionOnEnter only applies to incomplete slash tokens", () => {
  const suggestions = [{ name: "help" }, { name: "history" }]
  assert.equal(shouldApplySuggestionOnEnter("/", suggestions, 0), true)
  assert.equal(shouldApplySuggestionOnEnter("/he", suggestions, 0), true)
  assert.equal(shouldApplySuggestionOnEnter("/help", suggestions, 0), false)
  assert.equal(shouldApplySuggestionOnEnter("/help extra", suggestions, 0), false)
})
