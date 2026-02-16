import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { registerProvider } from "../src/provider/router.mjs"
import { ToolRegistry } from "../src/tool/registry.mjs"
import { processTurnLoop } from "../src/session/loop.mjs"

let tmpDir

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kkcode-test-loop-"))
  process.env.KKCODE_HOME = tmpDir
  await ToolRegistry.initialize({
    config: { tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } } }
  })
})

after(async () => {
  delete process.env.KKCODE_HOME
  await rm(tmpDir, { recursive: true, force: true })
})

async function runLoop(opts) {
  return processTurnLoop(opts)
}

function createMockProvider(responses) {
  let callIndex = 0
  const impl = {
    async request(input) {
      const r = responses[Math.min(callIndex++, responses.length - 1)]
      return typeof r === "function" ? r(input) : r
    },
    async *requestStream(input) {
      const r = responses[Math.min(callIndex++, responses.length - 1)]
      const res = typeof r === "function" ? r(input) : r
      if (res.text) yield { type: "text", content: res.text }
      for (const call of res.toolCalls || []) yield { type: "tool_call", call }
      yield { type: "usage", usage: res.usage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    },
    resetIndex() { callIndex = 0 }
  }
  return impl
}

function textResponse(text) {
  return { text, toolCalls: [], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }
}

function toolCallResponse(name, args) {
  return {
    text: "",
    toolCalls: [{ id: `tc_${Date.now()}`, name, args }],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }
  }
}

function baseConfig(overrides = {}) {
  return {
    config: {
      provider: { default: "mock", mock: { default_model: "test", timeout_ms: 5000, stream: false } },
      agent: { default_mode: "agent", max_steps: overrides.maxSteps || 3 },
      permission: { default_policy: overrides.permissionPolicy || "allow", rules: overrides.permissionRules || [] },
      session: { max_history: 30, recovery: false },
      tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } },
      usage: { aggregation: ["turn"], budget: {} },
      ui: { markdown_render: false }
    }
  }
}

// Register mock provider once
const mockProvider = createMockProvider([textResponse("hello")])
registerProvider("mock", mockProvider)

test("loop: pure text reply", async () => {
  const provider = createMockProvider([textResponse("Hello from mock!")])
  registerProvider("mock", provider)

  const result = await runLoop({
    prompt: "say hello",
    mode: "agent",
    model: "test",
    providerType: "mock",
    sessionId: `ses_text_${Date.now()}`,
    configState: baseConfig()
  })

  assert.equal(result.reply, "Hello from mock!")
  assert.equal(result.toolEvents.length, 0)
  assert.equal(result.usage.input, 10)
  assert.equal(result.usage.output, 5)
})

test("loop: single tool call then text reply", async () => {
  const provider = createMockProvider([
    toolCallResponse("list", { path: "." }),
    textResponse("I listed the directory.")
  ])
  registerProvider("mock", provider)

  const result = await runLoop({
    prompt: "list current dir",
    mode: "agent",
    model: "test",
    providerType: "mock",
    sessionId: `ses_tool_${Date.now()}`,
    configState: baseConfig()
  })

  assert.equal(result.reply, "I listed the directory.")
  assert.equal(result.toolEvents.length, 1)
  assert.equal(result.toolEvents[0].name, "list")
  assert.equal(result.toolEvents[0].status, "completed")
})

test("loop: multi-step tool calls", async () => {
  const provider = createMockProvider([
    toolCallResponse("list", { path: "." }),
    toolCallResponse("list", { path: ".." }),
    textResponse("Done listing both directories.")
  ])
  registerProvider("mock", provider)

  const result = await runLoop({
    prompt: "list two dirs",
    mode: "agent",
    model: "test",
    providerType: "mock",
    sessionId: `ses_multi_${Date.now()}`,
    configState: baseConfig()
  })

  assert.equal(result.reply, "Done listing both directories.")
  assert.equal(result.toolEvents.length, 2)
})

test("loop: max steps reached", async () => {
  const provider = createMockProvider([
    toolCallResponse("list", { path: "." })
  ])
  registerProvider("mock", provider)

  const result = await runLoop({
    prompt: "keep listing forever",
    mode: "agent",
    model: "test",
    providerType: "mock",
    sessionId: `ses_max_${Date.now()}`,
    configState: baseConfig({ maxSteps: 2 })
  })

  assert.ok(result.reply.toLowerCase().includes("max steps"))
  assert.equal(result.toolEvents.length, 2)
})

test("loop: permission deny causes tool error", async () => {
  const provider = createMockProvider([
    toolCallResponse("bash", { command: "echo hi" }),
    textResponse("Could not run bash.")
  ])
  registerProvider("mock", provider)

  const result = await runLoop({
    prompt: "run echo",
    mode: "agent",
    model: "test",
    providerType: "mock",
    sessionId: `ses_deny_${Date.now()}`,
    configState: baseConfig({ permissionPolicy: "deny" })
  })

  assert.equal(result.toolEvents.length, 1)
  assert.equal(result.toolEvents[0].name, "bash")
  assert.equal(result.toolEvents[0].status, "error")
  assert.ok(result.toolEvents[0].output.includes("permission denied"))
})
