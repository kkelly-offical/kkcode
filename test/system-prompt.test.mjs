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
  assert.ok(labels.includes("mode_contract"))
  assert.ok(labels.includes("skills"))
  assert.ok(labels.includes("env"))
  assert.match(prompt.text, /## task/)
  assert.match(prompt.text, /structured brief fields/)
  assert.match(prompt.text, /Execution contract/)
  assert.match(prompt.text, /CLI Assistant Contract/)
  assert.match(prompt.text, /# Mode Contract/)
  assert.match(prompt.text, /`plan`: produce a spec\/plan only; do not execute file mutations/i)
  assert.match(prompt.text, /longagent.*staged multi-file delivery lane/i)
  assert.match(prompt.text, /CLI-first personal assistant/)
  assert.match(prompt.text, /Agent modes as the default lane/i)
  // the approval level is what separates Agent / Agent · Auto / YOLO, and the
  // model must not treat a wider mode as pre-approval for edits
  assert.match(prompt.text, /approval level, not the lane/i)
  // this now comes from the mode contract block, which spells the aliases with
  // backticks and separators rather than as a bare agent/code/coding run
  assert.match(prompt.text, /`agent` \/ `code` \/ `coding`: compatibility aliases/i)
  assert.match(prompt.text, /continue an interrupted local transaction/i)
  assert.match(prompt.text, /Do not imply unsupported product surfaces/)
  assert.match(prompt.text, /\$compat-skill: compat description/)
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

test("assistant mode prompt requires explicit subagent delegation tools", async () => {
  const prompt = await buildSystemPromptBlocks({
    mode: "assistant",
    model: "gpt-4o-mini",
    cwd: process.cwd(),
    tools: [{ name: "task" }, { name: "task_group" }],
    skills: [],
    userInstructions: "",
    projectContext: "",
    language: "en"
  })

  const modeBlock = prompt.blocks.find((block) => block.label === "mode")
  assert.ok(modeBlock)
  assert.match(modeBlock.text, /explicitly asks to summon/)
  assert.match(modeBlock.text, /task_group/)
  assert.match(modeBlock.text, /inherit_context=true/)
})

test("the mode contract is injected exactly once", async () => {
  // modeReminder used to prepend renderPublicModeContract() while a dedicated
  // mode_contract block emitted the same text, so ~8% of every prompt was a
  // verbatim duplicate.
  for (const mode of ["assistant", "plan", "longagent"]) {
    const prompt = await buildSystemPromptBlocks({
      mode,
      model: "gpt-4o-mini",
      cwd: process.cwd(),
      tools: [],
      skills: [],
      userInstructions: "",
      projectContext: "",
      language: "en"
    })
    const occurrences = prompt.text.split("# Mode Contract").length - 1
    assert.equal(occurrences, 1, `${mode} mode injected the contract ${occurrences} times`)
  }
})
