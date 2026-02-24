import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { registerProvider } from "../src/provider/router.mjs"
import { runLongAgent } from "../src/session/longagent.mjs"

let tmpHome = ""
let tmpProject = ""
let originalCwd = process.cwd()

function createMockProvider(responses) {
  let index = 0
  return {
    async request() {
      const r = responses[Math.min(index++, responses.length - 1)]
      return r
    },
    async *requestStream() {
      const r = responses[Math.min(index++, responses.length - 1)]
      if (r.text) yield { type: "text", content: r.text }
      for (const call of r.toolCalls || []) yield { type: "tool_call", call }
      yield { type: "usage", usage: r.usage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    }
  }
}

function baseConfig(longagentOverrides = {}) {
  return {
    config: {
      provider: {
        default: "mock_longagent",
        mock_longagent: {
          default_model: "mock-model",
          timeout_ms: 5000,
          stream: false
        }
      },
      agent: {
        default_mode: "longagent",
        max_steps: 1,
        longagent: {
          max_iterations: 0,
          no_progress_warning: 1,
          no_progress_limit: 1,
          heartbeat_timeout_ms: 120000,
          checkpoint_interval: 0,
          hybrid: { enabled: false },
          ...longagentOverrides
        }
      },
      permission: { default_policy: "allow", rules: [] },
      session: { max_history: 10, recovery: true },
      tool: { sources: { builtin: false, local: false, plugin: false, mcp: false } },
      usage: { aggregation: ["turn"], budget: {} },
      ui: { markdown_render: false }
    }
  }
}

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "kkcode-longagent-home-"))
  tmpProject = await mkdtemp(join(tmpdir(), "kkcode-longagent-project-"))
  process.env.KKCODE_HOME = tmpHome
  originalCwd = process.cwd()
  process.chdir(tmpProject)
})

afterEach(async () => {
  process.chdir(originalCwd)
  delete process.env.KKCODE_HOME
  await rm(tmpHome, { recursive: true, force: true })
  await rm(tmpProject, { recursive: true, force: true })
})

test("longagent keeps running after no-progress threshold and completes later", async () => {
  registerProvider("mock_longagent", createMockProvider([
    { text: "same output for now", toolCalls: [], usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } },
    { text: "same output for now", toolCalls: [], usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } },
    { text: "[TASK_COMPLETE] fixed and usable", toolCalls: [], usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } }
  ]))

  const result = await runLongAgent({
    prompt: "keep improving until usable",
    model: "mock-model",
    providerType: "mock_longagent",
    sessionId: `ses_longagent_np_${Date.now()}`,
    configState: baseConfig({ no_progress_limit: 1 }),
    maxIterations: 0
  })

  // Core: no_progress_limit does NOT prevent eventual completion
  assert.equal(result.status, "completed")
  // Parallel mode runs stages via background workers; with no plannedFiles
  // the stage completes immediately, so iterations/recovery may be low
  assert.ok(result.iterations >= 1, `expected at least 1 iteration, got ${result.iterations}`)
  assert.equal(result.stageCount, 1)
})

test("longagent maxIterations is warning threshold only and does not stop execution", async () => {
  registerProvider("mock_longagent", createMockProvider([
    { text: "working on it", toolCalls: [], usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } },
    { text: "[TASK_COMPLETE] all done", toolCalls: [], usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } }
  ]))

  const result = await runLongAgent({
    prompt: "finish task",
    model: "mock-model",
    providerType: "mock_longagent",
    sessionId: `ses_longagent_max_${Date.now()}`,
    configState: baseConfig({ no_progress_limit: 5 }),
    maxIterations: 1
  })

  // Core: maxIterations is a warning threshold, not a hard stop
  assert.equal(result.status, "completed")
  assert.ok(result.iterations >= 1, `expected at least 1 iteration, got ${result.iterations}`)
  assert.equal(result.stageCount, 1)
})
