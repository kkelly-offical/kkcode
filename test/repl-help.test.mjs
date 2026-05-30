import test from "node:test"
import assert from "node:assert/strict"
import { buildHelpText, buildShortcutLegend } from "../src/ui/repl-help.mjs"

test("buildHelpText keeps the public lane descriptions together", () => {
  const text = buildHelpText({
    providers: ["openai", "anthropic"],
    userRootPath: "~/.kkcode"
  })

  assert.match(text, /return to the unified assistant/i)
  assert.match(text, /assistant = unified daily lane/i)
  assert.match(text, /compatibility aliases for assistant/i)
  assert.match(text, /longagent = staged/i)
  assert.match(text, /Plugin packages\s+\.kkcode-plugin/i)
})

test("buildShortcutLegend keeps the lane cycle wording explicit", () => {
  const text = buildShortcutLegend()
  assert.match(text, /Explicit workflows/)
  assert.match(text, /Shift\+Tab cycle permission level/)
  assert.match(text, /Esc interrupt turn/)
})
