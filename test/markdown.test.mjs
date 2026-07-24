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

test("renderMarkdown: links retain readable labels and targets", () => {
  const result = renderMarkdown(
    "[KK Code](https://github.com/kkelly-offical/kkcode) and <https://example.com/docs>"
  )
  assert.equal(
    result,
    "KK Code (https://github.com/kkelly-offical/kkcode) and https://example.com/docs"
  )
})

test("renderMarkdown: task lists and strikethrough", () => {
  const result = renderMarkdown("- [x] ~~legacy~~ path\n- [ ] next release")
  assert.equal(result, "\u2611 legacy path\n\u2610 next release")
})

test("renderMarkdown: simple tables preserve alignment and inline Markdown", () => {
  const result = renderMarkdown([
    "| Name | State |",
    "| :--- | ---: |",
    "| **alpha** | `done` |"
  ].join("\n"))

  assert.equal(result, [
    "\u2502 Name  \u2502 State \u2502",
    "\u251c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524",
    "\u2502 alpha \u2502  done \u2502"
  ].join("\n"))
})

test("renderMarkdown: escaped pipes and code-span pipes stay inside table cells", () => {
  const result = renderMarkdown([
    "| Expression | Meaning |",
    "| --- | --- |",
    "| `a|b` | left \\| right |"
  ].join("\n"))

  assert.ok(result.includes("a|b"))
  assert.ok(result.includes("left | right"))
  assert.equal(result.split("\n").length, 3)
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

test("createStreamRenderer: does not flush incomplete inline Markdown", () => {
  const sr = createStreamRenderer()
  assert.equal(sr.push("before **bo"), "")
  assert.equal(sr.push("ld** and `co"), "")
  assert.equal(sr.push("de`\n"), "before bold and code\n")
  assert.equal(sr.flush(), "")
})

test("createStreamRenderer: output is invariant across arbitrary chunk boundaries", () => {
  const samples = [
    "# Heading\nA **bold** and *italic* line with `code`.",
    "# Heading\r\nA CRLF line\r\nand a lone\rreturn",
    "- [x] ~~old~~\n- [ ] [new](https://example.com/a_b)",
    "```js\nconst value = `a|b`\n```\nafter",
    "| Name | Result |\n| :--- | ---: |\n| alpha | **pass** |\nnext"
  ]

  for (const source of samples) {
    const expected = renderMarkdown(source)

    for (let split = 0; split <= source.length; split++) {
      const sr = createStreamRenderer()
      const actual = sr.push(source.slice(0, split)) +
        sr.push(source.slice(split)) +
        sr.flush()
      assert.equal(actual, expected, `split ${split} of ${JSON.stringify(source)}`)
    }

    const characterStream = createStreamRenderer()
    let actual = ""
    for (const character of source) actual += characterStream.push(character)
    actual += characterStream.flush()
    assert.equal(actual, expected, `character chunks of ${JSON.stringify(source)}`)
  }
})

test("createStreamRenderer: holds a trailing CR so split CRLF emits one newline", () => {
  const sr = createStreamRenderer()
  assert.equal(sr.push("first\r"), "")
  assert.equal(sr.push("\nsecond\r"), "first\n")
  assert.equal(sr.push("third"), "second\n")
  assert.equal(sr.flush(), "third")
})

test("createStreamRenderer: sanitizes controls after reassembling split records", () => {
  const source = "ok\x1b[2J\r\nnext\x1b]52;c;SGFja2Vk\x07"
  const expected = renderMarkdown(source)

  for (let split = 0; split <= source.length; split++) {
    const sr = createStreamRenderer()
    const actual = sr.push(source.slice(0, split))
      + sr.push(source.slice(split))
      + sr.flush()
    assert.equal(actual, expected, `split ${split}`)
    assert.doesNotMatch(actual, /\x1b\[2J|\x1b\]52/)
  }
})

test("renderMarkdown: returns ANSI styles without re-rendering opaque spans", () => {
  const previousNoColor = process.env.NO_COLOR
  const ownTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
  delete process.env.NO_COLOR
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: true
  })

  try {
    const result = renderMarkdown(
      "[link_with_underscores](https://example.com/a_b) `**literal**` ~~removed~~"
    )
    assert.match(result, /\u001b\[4m/)
    assert.match(result, /\u001b\[36m\*\*literal\*\*\u001b\[0m/)
    assert.match(result, /\u001b\[9mremoved\u001b\[29m/)
    assert.ok(result.includes("https://example.com/a_b"))
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = previousNoColor
    if (ownTtyDescriptor) Object.defineProperty(process.stdout, "isTTY", ownTtyDescriptor)
    else delete process.stdout.isTTY
  }
})

test("renderMarkdown: neutralizes terminal control injection before styling", () => {
  const rendered = renderMarkdown("ok\x1b[2J\x1b[Howned\x1b]52;c;SGFja2Vk\x07")
  assert.doesNotMatch(rendered, /\x1b\[2J|\x1b\[H|\x1b\]52/)
  assert.match(rendered, /␛\[2J/)
  assert.match(rendered, /␇/)
})
