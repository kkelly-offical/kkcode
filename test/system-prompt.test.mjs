import test from "node:test"
import assert from "node:assert/strict"
import { defineAgent } from "../src/agent/agent.mjs"
import { buildSystemPromptBlocks, providerPromptByModel } from "../src/session/system-prompt.mjs"

test("system prompt routes claude models to anthropic prompt", async () => {
  const text = await providerPromptByModel("claude-3-5-sonnet-latest")
  assert.ok(text.includes("anthropic mode"))
})

test("system prompt routes gpt models to openai prompt", async () => {
  const text = await providerPromptByModel("gpt-4o-mini")
  assert.ok(text.includes("openai mode"))
})

test("system prompt assembles stable tool and skill blocks", async () => {
  const prompt = await buildSystemPromptBlocks({
    mode: "agent",
    model: "gpt-4o-mini",
    cwd: process.cwd(),
    tools: [{ name: "task" }],
    skills: [{ name: "compat-skill", description: "compat description" }],
    userInstructions: "",
    projectContext: "",
    language: "en"
  })

  const labels = prompt.blocks.map((block) => block.label)
  assert.ok(labels.includes("provider"))
  assert.ok(labels.includes("tools"))
  assert.ok(labels.includes("output_strategy"))
  assert.ok(labels.includes("assistant_contract"))
  assert.ok(labels.includes("skills"))
  assert.ok(labels.includes("env"))
  assert.match(prompt.text, /## task/)
  assert.match(prompt.text, /structured brief fields/)
  assert.match(prompt.text, /Execution contract/)
  assert.match(prompt.text, /CLI Assistant Contract/)
  assert.match(prompt.text, /CLI-first assistant/)
  assert.match(prompt.text, /default general execution lane/)
  assert.match(prompt.text, /continue an interrupted local transaction/i)
  assert.match(prompt.text, /Do not imply unsupported product surfaces/)
  assert.match(prompt.text, /\/compat-skill: compat description/)
})

test("system prompt includes custom subagent catalog block", async () => {
  const name = `compat-subagent-${Date.now()}`
  defineAgent({
    name,
    description: "custom compat subagent",
    mode: "subagent",
    permission: "readonly",
    tools: ["read"],
    hidden: false,
    _customAgent: true,
    _promptCache: ""
  })

  const prompt = await buildSystemPromptBlocks({
    mode: "agent",
    model: "gpt-4o-mini",
    cwd: process.cwd(),
    tools: [],
    skills: [],
    userInstructions: "",
    projectContext: "",
    language: "en"
  })

  const subagentBlock = prompt.blocks.find((block) => block.label === "subagents")
  assert.ok(subagentBlock)
  assert.match(subagentBlock.text, /# Available Sub-agents/)
  assert.match(subagentBlock.text, new RegExp(name))
})
