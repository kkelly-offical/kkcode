import test from "node:test"
import assert from "node:assert/strict"
import { ToolRegistry } from "../src/kernel/tool/registry.mjs"

const CONTRACT_CONFIG = {
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
  },
  runtime: {}
}

test("tool surface covers the shipped CLI general assistant lanes", async () => {
  const tools = await ToolRegistry.list({ config: CONTRACT_CONFIG, cwd: process.cwd() })
  const names = new Set(tools.map((tool) => tool.name))

  for (const name of ["read", "write", "edit", "patch"]) {
    assert.ok(names.has(name), `missing coding tool ${name}`)
  }
  for (const name of ["sysinfo", "list", "glob", "grep"]) {
    assert.ok(names.has(name), `missing local inspection tool ${name}`)
  }
  for (const name of ["bash", "task", "task_group", "background_output", "background_cancel", "task_list", "task_parallel", "task_get", "task_stop", "task_output"]) {
    assert.ok(names.has(name), `missing execution/delegation tool ${name}`)
  }
  for (const name of ["git_status", "git_info", "git_snapshot", "git_restore"]) {
    assert.ok(names.has(name), `missing repo/release tool ${name}`)
  }
  for (const name of ["websearch", "webfetch", "codesearch"]) {
    assert.ok(names.has(name), `missing research tool ${name}`)
  }
  for (const name of ["enter_plan", "exit_plan", "question"]) {
    assert.ok(names.has(name), `missing coordination tool ${name}`)
  }
})

test("tool surface exposes only the approved local browser bridge, not desktop/mobile/voice control", async () => {
  const tools = await ToolRegistry.list({ config: CONTRACT_CONFIG, cwd: process.cwd() })
  const names = tools.map((tool) => tool.name)

  assert.deepEqual(names.filter((name) => /desktop|chrome|mobile|voice|bridge/i.test(name)), ['browser_bridge'])
  const bridge = tools.find(tool => tool.name === 'browser_bridge')
  assert.ok(bridge.inputSchema)
  assert.equal(JSON.stringify(bridge.inputSchema).includes('evaluate'), false, 'the bridge is not an unrestricted JavaScript/CDP execution surface')
})
