import test from "node:test"
import assert from "node:assert/strict"
import { collectInput } from "../src/repl.mjs"

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
