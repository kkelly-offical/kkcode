import test from "node:test"
import assert from "node:assert/strict"
import { ToolRegistry } from "../src/tool/registry.mjs"

const TEST_CONFIG = {
  tool: {
    sources: {
      builtin: true,
      local: false,
      plugin: false,
      mcp: false
    }
  },
  mcp: {
    auto_discover: false
  }
}

test("tool registry exposes sysinfo in agent and plan-safe modes", async () => {
  const agentTools = await ToolRegistry.list({ mode: "agent", cwd: process.cwd(), config: TEST_CONFIG })
  const planTools = await ToolRegistry.list({ mode: "plan", cwd: process.cwd(), config: TEST_CONFIG })

  assert.ok(agentTools.some((tool) => tool.name === "sysinfo"))
  assert.ok(planTools.some((tool) => tool.name === "sysinfo"))
})

test("sysinfo returns structured system and workspace sections", async () => {
  await ToolRegistry.initialize({ config: TEST_CONFIG, cwd: process.cwd(), force: true })
  const tool = await ToolRegistry.get("sysinfo")
  assert.ok(tool)
  const result = await tool.execute({ sections: ["os", "runtime", "workspace", "memory"] }, { cwd: process.cwd() })

  assert.equal(typeof result.generatedAt, "string")
  assert.equal(result.sections.os.platform, process.platform)
  assert.equal(result.sections.os.arch, process.arch)
  assert.equal(result.sections.runtime.nodeVersion, process.version)
  assert.equal(result.sections.workspace.cwd, process.cwd())
  assert.equal(typeof result.sections.workspace.isGitRepo, "boolean")
  assert.equal(typeof result.sections.memory.totalBytes, "number")
  assert.equal(typeof result.summary, "string")
})
