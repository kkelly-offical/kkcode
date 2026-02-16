import test from "node:test"
import assert from "node:assert/strict"
import { renderMarkdown, createStreamRenderer } from "../src/theme/markdown.mjs"

// Force NO_COLOR so paint() returns plain text for predictable assertions
process.env.NO_COLOR = "1"

test("renderMarkdown: empty input", () => {
  assert.equal(renderMarkdown(""), "")
  assert.equal(renderMarkdown(null), "")
})

test("renderMarkdown: headers", () => {
  const result = renderMarkdown("# Title\n## Subtitle\n### H3")
  assert.ok(result.includes("Title"))
  assert.ok(result.includes("Subtitle"))
  assert.ok(result.includes("H3"))
})

test("renderMarkdown: code block with language", () => {
  const result = renderMarkdown("```js\nconst x = 1\n```")
  assert.ok(result.includes("const x = 1"))
  assert.ok(result.includes("js"))
})

test("renderMarkdown: code block without language", () => {
  const result = renderMarkdown("```\nplain code\n```")
  assert.ok(result.includes("plain code"))
})

test("renderMarkdown: inline code", () => {
  const result = renderMarkdown("Use `foo()` here")
  assert.ok(result.includes("foo()"))
})

test("renderMarkdown: bold and italic", () => {
  const result = renderMarkdown("**bold** and *italic* text")
  assert.ok(result.includes("bold"))
  assert.ok(result.includes("italic"))
})

test("renderMarkdown: unordered list", () => {
  const result = renderMarkdown("- item one\n- item two")
  assert.ok(result.includes("item one"))
  assert.ok(result.includes("item two"))
})

test("renderMarkdown: ordered list", () => {
  const result = renderMarkdown("1. first\n2. second")
  assert.ok(result.includes("first"))
  assert.ok(result.includes("second"))
})

test("renderMarkdown: blockquote", () => {
  const result = renderMarkdown("> quoted text")
  assert.ok(result.includes("quoted text"))
})

test("createStreamRenderer: reassembles lines", () => {
  const sr = createStreamRenderer()
  let out = ""
  out += sr.push("# Hel")
  out += sr.push("lo\n")
  out += sr.push("world")
  out += sr.flush()
  assert.ok(out.includes("Hello"))
  assert.ok(out.includes("world"))
})

test("createStreamRenderer: code block buffering", () => {
  const sr = createStreamRenderer()
  let out = ""
  out += sr.push("```\n")
  out += sr.push("code line\n")
  out += sr.push("```\n")
  out += sr.flush()
  assert.ok(out.includes("code line"))
})

test("createStreamRenderer: flush empty buffer", () => {
  const sr = createStreamRenderer()
  assert.equal(sr.flush(), "")
})
