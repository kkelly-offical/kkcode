import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { registerProvider } from "../src/kernel/provider/router.mjs"
import { ToolRegistry } from "../src/kernel/tool/registry.mjs"
import { PermissionEngine } from "../src/kernel/permission/engine.mjs"
import { processTurnLoop } from "../src/kernel/session/loop.mjs"
import { flushNow } from "../src/kernel/session/store.mjs"
import { EventBus } from "../src/kernel/core/events.mjs"
import { EVENT_TYPES } from "../src/kernel/core/constants.mjs"
import { runWithRuntime } from "../src/kernel/core/runtime-context.mjs"

const PROVIDER = "mock-session-ordering"
let root
let workDir
let previousHome
let sessionCounter = 0

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kkcode-session-ordering-"))
  workDir = join(root, "work")
  await mkdir(workDir, { recursive: true })
  previousHome = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = join(root, "home")
  PermissionEngine.setTrusted(true)
})

afterEach(async () => {
  try { await flushNow() } finally {
    PermissionEngine.setTrusted(false)
    if (previousHome === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

function baseConfig() {
  return {
    config: {
      provider: { default: PROVIDER, [PROVIDER]: { default_model: "test", timeout_ms: 5000, stream: false } },
      agent: { default_mode: "agent", max_steps: 5, verify_completion: false },
      permission: { level: "yolo", rules: [] },
      session: { max_history: 30, recovery: false },
      tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } },
      usage: { aggregation: ["turn"], budget: {} },
      ui: { markdown_render: false }
    }
  }
}

function createProvider(responses) {
  let callIndex = 0
  const next = () => responses[Math.min(callIndex++, responses.length - 1)]
  return {
    async request() {
      const response = next()
      return { text: "", toolCalls: [], usage: { input: 1, output: 1 }, ...response }
    },
    async *requestStream() {
      const response = next()
      if (response.text) yield { type: "text", content: response.text }
      for (const call of response.toolCalls || []) yield { type: "tool_call", call }
      yield { type: "usage", usage: response.usage || { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }
      yield { type: "stop", reason: response.stopReason || "end_turn" }
    }
  }
}

async function runTurn(responses) {
  registerProvider(PROVIDER, createProvider(responses))
  const configState = baseConfig()
  await ToolRegistry.initialize({ config: configState.config, cwd: workDir, force: true })
  const starts = []
  const unsubscribe = EventBus.subscribe(event => {
    if (event.type === EVENT_TYPES.TOOL_START) starts.push(event.payload.invocationId)
  })
  try {
    const result = await runWithRuntime({ cwd: workDir }, () => processTurnLoop({
      prompt: "execute the controlled tool sequence",
      mode: "agent",
      model: "test",
      providerType: PROVIDER,
      sessionId: `ses_ordering_${Date.now()}_${++sessionCounter}`,
      configState
    }))
    return { result, starts }
  } finally {
    unsubscribe()
  }
}

function call(id, name, args) {
  return { id, name, args }
}

test("write then read in one response executes in model order and reads new content", async () => {
  await writeFile(join(workDir, "order.txt"), "old-content\n", "utf8")
  const { result, starts } = await runTurn([
    { toolCalls: [call("prime-read", "read", { path: "order.txt" })] },
    { toolCalls: [
      call("write-call", "write", { path: "order.txt", content: "new-content\n" }),
      call("read-call", "read", { path: "order.txt" })
    ] },
    { text: "done", toolCalls: [] }
  ])

  assert.deepEqual(starts, ["prime-read", "write-call", "read-call"])
  assert.deepEqual(result.toolEvents.map(event => event.invocationId), ["prime-read", "write-call", "read-call"])
  const readResult = result.toolEvents.find(event => event.invocationId === "read-call")
  assert.match(readResult.output, /new-content/)
  assert.doesNotMatch(readResult.output, /old-content/)
  assert.equal(await readFile(join(workDir, "order.txt"), "utf8"), "new-content\n")
})

test("edit then grep in one response executes in model order and searches edited content", async () => {
  await writeFile(join(workDir, "order.txt"), "const value = \"alpha-old\";\n", "utf8")
  const { result, starts } = await runTurn([
    { toolCalls: [call("prime-read", "read", { path: "order.txt" })] },
    { toolCalls: [
      call("edit-call", "edit", { path: "order.txt", before: "alpha-old", after: "alpha-new" }),
      call("grep-call", "grep", { path: "order.txt", pattern: "alpha-new", output_mode: "content" })
    ] },
    { text: "done", toolCalls: [] }
  ])

  assert.deepEqual(starts, ["prime-read", "edit-call", "grep-call"])
  assert.deepEqual(result.toolEvents.map(event => event.invocationId), ["prime-read", "edit-call", "grep-call"])
  const grepResult = result.toolEvents.find(event => event.invocationId === "grep-call")
  assert.match(grepResult.output, /alpha-new/)
  assert.doesNotMatch(grepResult.output, /alpha-old/)
  assert.equal(await readFile(join(workDir, "order.txt"), "utf8"), "const value = \"alpha-new\";\n")
})

test("consecutive independent read-only calls still start in parallel", async () => {
  await writeFile(join(workDir, "a.txt"), "alpha\n", "utf8")
  await writeFile(join(workDir, "b.txt"), "beta\n", "utf8")
  const originalGet = ToolRegistry.get
  const started = []
  let release
  const bothStarted = new Promise(resolve => { release = resolve })
  ToolRegistry.get = async function(name) {
    const tool = await originalGet.call(this, name)
    if (name !== "read" || !tool) return tool
    return {
      ...tool,
      async execute(args, ctx) {
        started.push(args.path)
        if (started.length === 2) release()
        let timer
        await Promise.race([
          bothStarted,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("read-only calls were serialized")), 1000)
          })
        ]).finally(() => clearTimeout(timer))
        return tool.execute(args, ctx)
      }
    }
  }

  try {
    const { result } = await runTurn([
      { toolCalls: [
        call("read-a", "read", { path: "a.txt" }),
        call("read-b", "read", { path: "b.txt" })
      ] },
      { text: "done", toolCalls: [] }
    ])
    assert.deepEqual(new Set(started), new Set(["a.txt", "b.txt"]))
    assert.match(result.toolEvents.find(event => event.invocationId === "read-a").output, /alpha/)
    assert.match(result.toolEvents.find(event => event.invocationId === "read-b").output, /beta/)
  } finally {
    ToolRegistry.get = originalGet
  }
})
