import test from "node:test"
import assert from "node:assert/strict"
import { ToolRegistry } from "../src/tool/registry.mjs"

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
  for (const name of ["list", "glob", "grep"]) {
    assert.ok(names.has(name), `missing local inspection tool ${name}`)
  }
  for (const name of ["bash", "task", "background_output", "background_cancel"]) {
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

test("tool surface does not pretend GUI-first assistant capabilities exist", async () => {
  const tools = await ToolRegistry.list({ config: CONTRACT_CONFIG, cwd: process.cwd() })
  const names = tools.map((tool) => tool.name)

  assert.equal(names.some((name) => /desktop|chrome|mobile|voice|bridge/i.test(name)), false)
})
