import test from "node:test"
import assert from "node:assert/strict"
import { applyCommandTemplate } from "../src/command/custom-commands.mjs"

test("applyCommandTemplate expands positional and raw args", () => {
  const tpl = "cmd $1 $2 raw=$ARGUMENTS path=${path}"
  const out = applyCommandTemplate(tpl, "foo bar baz", { path: "/tmp/x" })
  assert.equal(out, "cmd foo bar raw=foo bar baz path=/tmp/x")
})
