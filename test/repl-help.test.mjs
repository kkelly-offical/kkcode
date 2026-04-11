import test from "node:test"
import assert from "node:assert/strict"
import { buildHelpText, buildShortcutLegend } from "../src/ui/repl-help.mjs"

test("buildHelpText keeps the public lane descriptions together", () => {
  const text = buildHelpText({
    providers: ["openai", "anthropic"],
    userRootPath: "~/.kkcode"
  })

  assert.match(text, /quick mode switch to the public execution lanes/i)
  assert.match(text, /ask = read-only explanation/i)
  assert.match(text, /longagent = staged multi-file lane/i)
  assert.match(text, /Plugin packages\s+\.kkcode-plugin/i)
})

test("buildShortcutLegend keeps the lane cycle wording explicit", () => {
  const text = buildShortcutLegend()
  assert.match(text, /Quick lane switch/)
  assert.match(text, /Tab cycle lane/)
  assert.match(text, /Esc interrupt turn/)
})
