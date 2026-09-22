import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { createToolRegistry } from "../src/kernel/tool/registry.mjs"

const REGISTRY_CONFIG = { tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } } }

async function grepTool() {
  const registry = createToolRegistry({ mcpRegistry: { initialize: async () => {}, listTools: () => [] } })
  await registry.initialize({ config: REGISTRY_CONFIG, cwd: process.cwd(), allowProjectSources: false })
  const tools = await registry.list({})
  return tools.find((tool) => tool.name === "grep")
}

test("grep advertises one consistent snake_case naming convention", async () => {
  const tool = await grepTool()
  const keys = Object.keys(tool.inputSchema.properties)
  // Mixed camelCase/snake_case in one schema made models guess wrong on
  // adjacent tools; the advertised schema is snake_case only.
  assert.ok(keys.includes("max_count"), "max_count advertised")
  assert.ok(keys.includes("ignore_case"), "ignore_case advertised")
  assert.ok(!keys.includes("maxCount"), "camelCase maxCount no longer advertised")
  assert.ok(!keys.includes("ignoreCase"), "camelCase ignoreCase no longer advertised")
  for (const key of keys) {
    assert.match(key, /^[a-z][a-z0-9_]*$/, `${key} must be snake_case`)
  }
})

test("legacy camelCase grep arguments keep working as silent aliases", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "kkcode-grep-alias-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, "fixture.txt"), "Alpha\nbeta\nALPHA\n")

  const registry = createToolRegistry({ mcpRegistry: { initialize: async () => {}, listTools: () => [] } })
  await registry.initialize({ config: REGISTRY_CONFIG, cwd: root, allowProjectSources: false })
  const grep = await registry.get("grep")

  const snake = await grep.execute({ pattern: "alpha", path: "fixture.txt", output_mode: "content", ignore_case: true, max_count: 5 }, { cwd: root })
  const camel = await grep.execute({ pattern: "alpha", path: "fixture.txt", output_mode: "content", ignoreCase: true, maxCount: 5 }, { cwd: root })
  assert.doesNotMatch(String(snake), /\[search error\]/, "ripgrep must be installed for this integration test")
  assert.equal((String(snake).match(/alpha/gi) || []).length, 2, "snake_case ignore_case matches both cases")
  assert.deepEqual(camel, snake, "camelCase alias produces the same result")

  const limited = await grep.execute({ pattern: "alpha", path: "fixture.txt", output_mode: "content", ignore_case: true, max_count: 1 }, { cwd: root })
  assert.equal((String(limited).match(/alpha/gi) || []).length, 1, "max_count limits matches per file")
})
