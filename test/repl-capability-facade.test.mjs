import test from "node:test"
import assert from "node:assert/strict"
import { buildCapabilitySnapshot } from "../src/repl/capability-facade.mjs"

test("buildCapabilitySnapshot aggregates commands, skills, tools, mcp, and agents", async () => {
  const snapshot = await buildCapabilitySnapshot({
    mode: "agent",
    cwd: "/tmp/repo",
    configState: { config: {} },
    customCommands: [{ name: "ship" }, { name: "audit" }],
    skillRegistry: {
      isReady() { return true },
      list() { return [{}, {}, {}] }
    },
    toolRegistry: {
      async list() { return [{}, {}, {}, {}] }
    },
    mcpRegistry: {
      healthSnapshot() { return [{ ok: true }, { ok: false }] }
    },
    listAgents() { return [{}, {}] }
  })
  assert.deepEqual(snapshot, {
    mode: "agent",
    customCommands: 2,
    skills: 3,
    tools: 4,
    mcpServers: 2,
    healthyMcp: 1,
    agents: 2
  })
})
