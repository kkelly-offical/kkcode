import test from "node:test"
import assert from "node:assert/strict"
import { buildSystemPromptBlocks } from "../src/session/system-prompt.mjs"

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

  assert.match(prompt.text, /Fresh Session vs Forked Context vs Continued Session/)
  assert.match(prompt.text, /execution_mode="fork_context"/)
  assert.match(prompt.text, /Stay local when:/)
  assert.match(prompt.text, /Do NOT "peek" at unfinished delegated work/)
  assert.match(prompt.text, /Do NOT fabricate completion/)
})
