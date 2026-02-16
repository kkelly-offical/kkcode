import test from "node:test"
import assert from "node:assert/strict"
import { renderTemplate } from "../src/util/template.mjs"

test("renderTemplate supports ${x}, {{x}}, {x}", () => {
  const text = "A=${a}, B={{b}}, C={c}"
  const out = renderTemplate(text, { a: "1", b: "2", c: "3" })
  assert.equal(out, "A=1, B=2, C=3")
})
