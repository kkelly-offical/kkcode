import test from "node:test"
import assert from "node:assert/strict"
import { renderCapabilityPanel } from "../src/ui/repl-capability-panel.mjs"

test("renderCapabilityPanel formats capability counts", () => {
  const lines = renderCapabilityPanel({
    mode: "agent",
    customCommands: 2,
    skills: 3,
    tools: 4,
    healthyMcp: 1,
    mcpServers: 2,
    agents: 5
  })
  assert.deepEqual(lines, [
    "capability surface:",
    "  mode=agent",
    "  commands=2 skills=3 tools=4",
    "  mcp=1/2 healthy agents=5"
  ])
})
