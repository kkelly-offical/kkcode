import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { registerProvider } from "../src/provider/router.mjs"
import { runLongAgent } from "../src/session/longagent.mjs"
import { installBackgroundMock, restoreBackgroundMock } from "./helpers/background-mock.mjs"

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
          max_gate_attempts: 1,
          usability_gates: {
            prompt_user: "never",
            build: { enabled: false },
            test: { enabled: false },
            review: { enabled: false },
            health: { enabled: false },
            budget: { enabled: false }
          },
          // 0.4.0 起 Ultra 只有 hybrid 一套编排；这里关掉交互阶段，
          // 让用例专注于 no_progress / maxIterations 的阈值语义
          hybrid: {
            intake: false,
            intake_user_confirm: false,
            blueprint_review: false,
            completion_validation: false,
            scaffold: false
          },
          scaffold: { enabled: false },
          git: { enabled: false },
          // 这个文件测的是 0.4.x 的遗留阈值语义（no_progress/maxIterations 是
          // 警告不是硬停）。goal 模式下这些语义已被轮次循环取代 —— 显式关掉，
          // 让用例继续测它声称测的东西。
          ultra: { goal_mode: false },
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
  // 不装这个 mock 这些用例就是假绿：H4 的任务会跑进独立子进程，那里看不到
  // 上面 registerProvider 注册的 mock provider，实际结果是
  // `provider error: missing API key for openai provider` —— 而任务仍然被记成
  // completed（默认计划的 plannedFiles 为空，没有任何东西可校验），
  // 于是断言到的 "completed" 对应一次什么都没干的运行。
  installBackgroundMock({ reply: "[TASK_COMPLETE] mock worker finished" })
})

afterEach(async () => {
  restoreBackgroundMock()
  process.chdir(originalCwd)
  delete process.env.KKCODE_HOME
  await rm(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  await rm(tmpProject, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/** 任何一个子任务都不该是「因为 provider 不可用而空转」还算完成。 */
function assertTasksDidRealWork(taskProgress) {
  const tasks = Object.values(taskProgress || {})
  assert.ok(tasks.length > 0, "至少要有一个子任务")
  for (const task of tasks) {
    assert.ok(
      !String(task.lastReply || "").includes("provider error"),
      `子任务 ${task.taskId} 实际上没有跑起来：${task.lastReply}`
    )
  }
}

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
  assert.ok(result.iterations >= 1, `expected at least 1 iteration, got ${result.iterations}`)
  assert.equal(result.stageCount, 1)
  assertTasksDidRealWork(result.taskProgress)
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
  assertTasksDidRealWork(result.taskProgress)
})

// 记录当前事实，供 0.5.0 阶段 6 收口：no_progress_limit 与 max_iterations 目前
// 都是**死配置** —— 前者被读进一个再也没人用的局部变量，后者被 runHybridLongAgent
// 收下后完全忽略。上面两个用例之所以通过，不是因为「阈值只是警告」这条语义被
// 正确实现了，而是因为这两个配置根本不起作用。阶段 6 会把它们接到
// ultra.no_progress_rounds / 总轮次上限上，届时这两个用例需要重写。
test("no_progress_limit 与 max_iterations 目前不影响任何结果", async () => {
  registerProvider("mock_longagent", createMockProvider([
    { text: "[TASK_COMPLETE] done", toolCalls: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }
  ]))

  const tight = await runLongAgent({
    prompt: "finish task",
    model: "mock-model",
    providerType: "mock_longagent",
    sessionId: `ses_longagent_inert_a_${Date.now()}`,
    configState: baseConfig({ no_progress_limit: 1, max_iterations: 1 }),
    maxIterations: 1
  })

  const loose = await runLongAgent({
    prompt: "finish task",
    model: "mock-model",
    providerType: "mock_longagent",
    sessionId: `ses_longagent_inert_b_${Date.now()}`,
    configState: baseConfig({ no_progress_limit: 999, max_iterations: 999 }),
    maxIterations: 999
  })

  assert.equal(tight.status, loose.status, "两个配置差着三个数量级，结果却完全一样")
  assert.equal(tight.stageCount, loose.stageCount)
})
