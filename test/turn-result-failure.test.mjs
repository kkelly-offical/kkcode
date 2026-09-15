import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerProvider } from "../src/kernel/provider/router.mjs"
import { processTurnLoop } from "../src/kernel/session/loop.mjs"
import { EventBus } from "../src/kernel/core/events.mjs"
import { EVENT_TYPES } from "../src/kernel/core/constants.mjs"
import { createKernel } from "../src/kernel/index.mjs"
import { flushNow } from "../src/kernel/session/store.mjs"
import { toPublicResult, createOutputReporter } from "../src/cli/output-format.mjs"

/**
 * 1.0.0 契约收紧（阶段 5 reviewer finding）：provider 级失败时 turn.result 不再
 * 恒 "succeeded"。数据通路是 loop catch → engine → chat → toPublicResult，每一跳
 * 都要把 error 传下去；同时 `reply`/`content` 的 "provider error: " 前缀保持不动
 * —— background-worker 等文本消费方在匹配它（background-worker.mjs 的
 * silent provider error 探测），那不是可以顺手「清理」掉的字符串。
 *
 * CLI 端到端断言（退出码非零、stdout JSONL 纪律、stderr 摘要）在
 * test/e2e/headless-jsonl.test.mjs；本文件钉进程内的每一跳。
 */

const LOOP_PROVIDER = "mock_turnresult_loop"
const KERNEL_PROVIDER = "mock_turnresult_kernel"
const FAILURE_MESSAGE = "forced provider failure"

let home = ""
let workDir = ""
let originalCwd = ""

function failingProvider() {
  return {
    async request() {
      throw new Error(FAILURE_MESSAGE)
    },
    async *requestStream() {
      throw new Error(FAILURE_MESSAGE)
    }
  }
}

function loopConfig(providerType) {
  return {
    config: {
      provider: {
        default: providerType,
        [providerType]: { default_model: "mock-model", stream: true }
      },
      agent: { max_steps: 1 },
      permission: { default_policy: "allow", rules: [] },
      session: { max_history: 10, recovery: false },
      tool: { sources: { builtin: false, local: false, plugin: false, mcp: false } },
      usage: { aggregation: ["turn"] },
      ui: { markdown_render: false }
    }
  }
}

function kernelConfig(providerType) {
  return {
    source: {},
    config: {
      provider: {
        default: providerType,
        [providerType]: { default_model: "mock-model", timeout_ms: 5000, stream: false, retry_attempts: 1 }
      },
      agent: { default_mode: "agent", max_steps: 1 },
      permission: { level: "manual", rules: [] },
      session: { max_history: 10, recovery: false },
      tool: { sources: { builtin: false, local: false, plugin: false, mcp: false } },
      usage: { aggregation: ["turn"], budget: {} },
      ui: { markdown_render: false }
    }
  }
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), "kkcode-turnresult-home-"))
  workDir = await mkdtemp(join(tmpdir(), "kkcode-turnresult-cwd-"))
  process.env.KKCODE_HOME = home
  originalCwd = process.cwd()
  process.chdir(workDir)
  registerProvider(LOOP_PROVIDER, failingProvider())
  registerProvider(KERNEL_PROVIDER, failingProvider())
})

after(async () => {
  process.chdir(originalCwd)
  await flushNow()
  delete process.env.KKCODE_HOME
  await rm(home, { recursive: true, force: true })
  await rm(workDir, { recursive: true, force: true })
})

test("loop catch 透传 error 字段：reply 前缀不动，TURN_ERROR 事件序列不变", async () => {
  const sessionId = `ses_turnresult_loop_${Date.now()}`
  const seen = []
  const unsubscribe = EventBus.subscribe((event) => {
    if (event.sessionId === sessionId) seen.push(event.type)
  })
  let result
  try {
    result = await processTurnLoop({
      prompt: "hello",
      mode: "agent",
      model: "mock-model",
      providerType: LOOP_PROVIDER,
      sessionId,
      configState: loopConfig(LOOP_PROVIDER)
    })
  } finally {
    unsubscribe()
  }

  assert.equal(result.error, FAILURE_MESSAGE, "catch 路径必须把错误透传到结果对象")
  assert.equal(
    result.reply,
    `provider error: ${FAILURE_MESSAGE}`,
    "reply 的 provider error 前缀是文本消费方的既有契约，不能随这次收紧改动"
  )

  const lifecycle = seen.filter((type) =>
    [EVENT_TYPES.TURN_START, EVENT_TYPES.TURN_FINISH, EVENT_TYPES.TURN_ERROR].includes(type))
  assert.deepEqual(
    lifecycle,
    [EVENT_TYPES.TURN_START, EVENT_TYPES.TURN_ERROR],
    "失败路径的事件序列保持既有形态：turn.start → turn.error（无 turn.finish）"
  )
})

test("kernel.executeTurn 把 provider 级失败透传到引擎结果对象", async () => {
  const kernel = await createKernel({
    cwd: workDir,
    config: kernelConfig(KERNEL_PROVIDER),
    trustState: { trusted: true },
    boot: false
  })
  try {
    const result = await kernel.executeTurn({
      prompt: "hello",
      mode: "agent",
      model: "mock-model",
      providerType: KERNEL_PROVIDER,
      sessionId: `ses_turnresult_kernel_${Date.now()}`
    })

    assert.equal(result.error, FAILURE_MESSAGE, "engine 不得丢掉 loop 透传的 error")
    assert.equal(result.reply, `provider error: ${FAILURE_MESSAGE}`)

    // 这一跳就是 turn.result 的素材：status/error/content 三者的关系
    const record = toPublicResult(result)
    assert.equal(record.status, "failed")
    assert.equal(record.error, FAILURE_MESSAGE)
    assert.ok(record.content.startsWith("provider error: "), "content 前缀保持兼容")
  } finally {
    await kernel.shutdown()
  }
})

test("toPublicResult 失败语义：error → failed，预算阻断与 longagent 终态优先级不变", () => {
  assert.equal(toPublicResult({ reply: "ok" }).status, "succeeded")
  assert.equal(toPublicResult({ reply: "provider error: x", error: "x" }).status, "failed")
  assert.equal(
    toPublicResult({ reply: "provider error: x", error: "x", budgetExceeded: true }).status,
    "blocked",
    "预算阻断仍是独立终态，优先于 error"
  )
  assert.equal(
    toPublicResult({ reply: "provider error: x", error: "x", longagent: { status: "completed" } }).status,
    "completed",
    "longagent 航道以自己的终态为准，优先于 error"
  )
})

test("json 格式失败终态事件：status=failed、error 带详情、stdout 仍恰好一行", () => {
  let stdout = ""
  let stderr = ""
  const reporter = createOutputReporter("json", {
    stdout: { write(chunk) { stdout += chunk } },
    stderr: { write(chunk) { stderr += chunk } }
  })
  reporter.warning(`provider error: ${FAILURE_MESSAGE}`)
  reporter.finish({
    reply: `provider error: ${FAILURE_MESSAGE}`,
    error: FAILURE_MESSAGE,
    sessionId: "s",
    turnId: "t"
  })

  const lines = stdout.split("\n").filter(Boolean)
  assert.equal(lines.length, 1, "失败路径上 stdout 仍恰好一行终态事件")
  const event = JSON.parse(lines[0])
  assert.equal(event.type, "turn.result")
  assert.equal(event.status, "failed")
  assert.equal(event.error, FAILURE_MESSAGE)
  assert.ok(event.content.startsWith("provider error: "))
  assert.ok(stderr.includes(FAILURE_MESSAGE), "错误摘要走 stderr 诊断通道")
  assert.ok(!stderr.includes('"schemaVersion"'), "机器事件只属于 stdout")
})
