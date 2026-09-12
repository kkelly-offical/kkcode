// 1.0.0 阶段 2 完成判据 1（§6）：门面自足证明 —— 对照 Codex thread-manager-sample。
// 只经 src/kernel/index.mjs 的 createKernel 句柄跑通
// createKernel → 最小 executeTurn（mock provider）→ 收 turn.start/turn.finish
// 事件 → shutdown 全链路。
import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createKernel } from "../src/kernel/index.mjs"
// 2b 过渡：executeTurn 执行路径仍从进程级默认 provider 注册表解析（2c 才改为
// 实例注入），所以 mock provider 目前注册到默认注册表 —— 与现存全部
// loop/executeTurn 测试同款做法。
import { registerProvider } from "../src/provider/router.mjs"

const PROVIDER = "mock_kernel_smoke"

let homeDir
let workDir

before(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "kkcode-kernel-smoke-home-"))
  workDir = await mkdtemp(join(tmpdir(), "kkcode-kernel-smoke-cwd-"))
  process.env.KKCODE_HOME = homeDir
})

after(async () => {
  delete process.env.KKCODE_HOME
  await rm(homeDir, { recursive: true, force: true })
  await rm(workDir, { recursive: true, force: true })
})

function smokeConfig() {
  return {
    source: {},
    config: {
      provider: {
        default: PROVIDER,
        [PROVIDER]: { default_model: "mock-model", timeout_ms: 5000, stream: false, retry_attempts: 1 }
      },
      agent: { default_mode: "agent", max_steps: 3 },
      permission: { level: "yolo", rules: [] },
      session: { max_history: 10, recovery: false },
      tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } },
      usage: { aggregation: ["turn"], budget: {} },
      ui: { markdown_render: false }
    }
  }
}

registerProvider(PROVIDER, {
  async request() {
    return {
      text: "hello from kernel",
      toolCalls: [],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }
    }
  },
  async *requestStream() {
    yield { type: "text", content: "hello from kernel" }
    yield { type: "usage", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }
  }
})

test("kernel smoke: createKernel → executeTurn → turn events → shutdown", async () => {
  const hostEvents = []
  const kernel = await createKernel({
    cwd: workDir,
    config: smokeConfig(),
    trustState: { trusted: true },
    handlers: {
      onEvent: (event) => hostEvents.push(event)
    }
  })

  // boot 序列已在 createKernel 内作用于本实例注册表
  assert.equal(kernel.permissions.isTrusted(), true)
  assert.equal(kernel.tools.isReady(), true)
  assert.ok(kernel.providers.listProviders().includes("openai"))

  const { TURN_START, TURN_FINISH } = kernel.events.EVENT_TYPES
  const sessionId = "ses_kernel_smoke"
  const subscribed = []
  const unsubscribe = kernel.events.subscribe((event) => {
    if (event.sessionId === sessionId) subscribed.push(event.type)
  })

  const result = await kernel.executeTurn({
    prompt: "say hello",
    mode: "agent",
    model: "mock-model",
    providerType: PROVIDER,
    sessionId
  })

  assert.equal(result.reply, "hello from kernel")
  assert.equal(result.sessionId, sessionId)

  // turn 事件流经 kernel 实例的事件面（订阅通道与 handlers.onEvent 都收到）
  assert.ok(subscribed.includes(TURN_START), `missing turn.start in ${subscribed.join(",")}`)
  assert.ok(subscribed.includes(TURN_FINISH), `missing turn.finish in ${subscribed.join(",")}`)
  assert.ok(
    hostEvents.some((event) => event.type === TURN_START && event.sessionId === sessionId),
    "handlers.onEvent did not receive turn.start"
  )
  assert.ok(
    hostEvents.some((event) => event.type === TURN_FINISH && event.sessionId === sessionId),
    "handlers.onEvent did not receive turn.finish"
  )
  unsubscribe()

  // 会话落盘面（platform 层）经 kernel.sessions 可读
  const stored = await kernel.sessions.getSession(sessionId)
  assert.equal(stored?.session?.id || stored?.id, sessionId)

  await kernel.shutdown()
  // shutdown 幂等；桥接与宿主回调已退订
  await kernel.shutdown()
  assert.equal(kernel.events.listenerCount(), 0)
})
