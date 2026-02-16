import test from "node:test"
import assert from "node:assert/strict"
import { providerPromptByModel } from "../src/session/system-prompt.mjs"

test("system prompt routes claude models to anthropic prompt", async () => {
  const text = await providerPromptByModel("claude-3-5-sonnet-latest")
  assert.ok(text.includes("anthropic mode"))
})

test("system prompt routes gpt models to openai prompt", async () => {
  const text = await providerPromptByModel("gpt-4o-mini")
  assert.ok(text.includes("openai mode"))
})
