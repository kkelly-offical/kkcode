import test from "node:test"
import assert from "node:assert/strict"
import { createToolRegistry } from "../src/kernel/tool/registry.mjs"
import { toolDescriptions, toolGroupFor } from "../src/kernel/session/system-prompt.mjs"

const REGISTRY_CONFIG = { tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } } }

async function builtinTools() {
  const registry = createToolRegistry({ mcpRegistry: { initialize: async () => {}, listTools: () => [] } })
  await registry.initialize({ config: REGISTRY_CONFIG, cwd: process.cwd(), allowProjectSources: false })
  return registry.list({})
}

test("every builtin tool maps to a named group, not the fallback", async () => {
  const tools = await builtinTools()
  assert.ok(tools.length >= 40, `expected the full builtin surface, got ${tools.length}`)
  const fallback = tools.filter((tool) => toolGroupFor(tool.name) === "Other tools").map((tool) => tool.name)
  assert.deepEqual(fallback, [], `builtin tools missing a group: ${fallback.join(", ")}`)
})

test("the Available Tools block renders grouped sections in a stable order", async () => {
  const tools = await builtinTools()
  const text = await toolDescriptions(tools)
  assert.match(text, /^# Available Tools/)

  const groupOrder = [
    "### File operations",
    "### Search",
    "### Shell & system",
    "### Web",
    "### Planning & state",
    "### Delegation & background",
    "### Git & snapshots",
    "### Notebook",
    "### Skills"
  ]
  let cursor = -1
  for (const header of groupOrder) {
    const at = text.indexOf(header)
    assert.ok(at > cursor, `${header} missing or out of order`)
    cursor = at
  }

  // every tool still renders exactly once under its group
  for (const tool of tools) {
    const occurrences = text.split(`## ${tool.name}\n`).length - 1
    assert.equal(occurrences, 1, `${tool.name} rendered ${occurrences} times`)
  }
})

test("group membership is stable for MCP and unknown tools; tools without prompt files stay out of the block", async () => {
  assert.equal(toolGroupFor("mcp_filesystem_read_file"), "MCP tools")
  assert.equal(toolGroupFor("totally_custom_tool"), "Other tools")
  // MCP and dynamic tools carry their own descriptions in the tool schema;
  // without a prompt file they are not repeated in the system prompt block.
  const text = await toolDescriptions([{ name: "mcp_filesystem_read_file" }, { name: "totally_custom_tool" }])
  assert.equal(text, "")
})
