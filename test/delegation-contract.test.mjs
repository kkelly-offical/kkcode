import test from "node:test"
import assert from "node:assert/strict"
import { buildSystemPromptBlocks, toolDescriptions } from "../src/kernel/session/system-prompt.mjs"

test("task tool prompt encodes fork-context and no-peek delegation contract", async () => {
  const prompt = await buildSystemPromptBlocks({
    mode: "agent",
    model: "gpt-4o-mini",
    cwd: process.cwd(),
    tools: [{ name: "task" }],
    skills: [],
    userInstructions: "",
    projectContext: "",
    language: "en"
  })

  assert.match(prompt.text, /tool_search for detailed guidance/)
  const instructions = await toolDescriptions([{ name: 'task' }])
  assert.match(instructions, /Fresh Session vs Forked Context vs Continued Session/)
  assert.match(instructions, /execution_mode="fork_context"/)
  assert.match(instructions, /Stay local when:/)
  assert.match(instructions, /Do NOT "peek" at unfinished delegated work/)
  assert.match(instructions, /Do NOT fabricate completion/)
})
