import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { registerProvider } from "../src/kernel/provider/router.mjs"
import { PermissionEngine } from "../src/kernel/permission/engine.mjs"
import { ToolRegistry } from "../src/kernel/tool/registry.mjs"
import { EventBus } from "../src/kernel/core/events.mjs"
import { EVENT_TYPES } from "../src/kernel/core/constants.mjs"
import { processTurnLoop } from "../src/session/loop.mjs"
import { createRenderStream, registerStreamByteRenderer } from "../src/session/render-stream.mjs"
import { setColorEnabled } from "../src/theme/color.mjs"
import { createStreamByteRenderer, installStreamByteRenderer } from "../src/theme/stream-byte-renderer.mjs"

/**
 * 1.0.0 阶段 3a 的硬判据（§6 阶段 3 完成判据 4，§7.5）：渲染解耦之后，
 * TUI/CLI 关键路径的输出字节流必须与迁移前**逐字节一致**。
 *
 * 金样（test/fixtures/render-snapshot-baseline.json）是在迁移前的代码上
 * 实跑同一场景捕获的 output.write 字节流 + 事件序列（捕获脚本与下面的
 * 驱动同构）。本测试钉住三件事：
 *   1. 字节流不变 —— ANSI 着色/markdown 渲染搬到前端 sink 后零行为变更；
 *   2. 迁移前已存在的事件类型序列与 payload 不变（新事件只增不改）；
 *   3. 新增的数据事件（stream.tool_call / stream.provider_compaction /
 *      stream.end / turn.auto_continue / turn.validation_skipped）按语义出现。
 */

// 名字与金样捕获时保持一致：turn.start 事件的 payload 里带 providerType。
const PROVIDER = "mock_3a_snap"
const FIXTURE_URL = new URL("./fixtures/render-snapshot-baseline.json", import.meta.url)

let homeDir
let workDir
let originalCwd

before(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "kkcode-render-snap-home-"))
  workDir = await mkdtemp(join(tmpdir(), "kkcode-render-snap-cwd-"))
  process.env.KKCODE_HOME = homeDir
  originalCwd = process.cwd()
  await writeFile(join(workDir, "a.txt"), "alpha\n")
  await writeFile(join(workDir, "b.txt"), "beta\n")
  // 回合的 cache-point checkpoint 会在 cwd 下落一个 .kkcode 目录；预建它，
  // list 工具的输出就不依赖「checkpoint 与 list 谁先发生」的时序。
  await mkdir(join(workDir, ".kkcode"), { recursive: true })
  process.chdir(workDir)
  PermissionEngine.setTrusted(true)
  await ToolRegistry.initialize({
    config: { tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } } }
  })
  // 前端登记字节渲染器 —— 与入口进程经 loadTheme()/activity-renderer 的登记同款
  installStreamByteRenderer()
})

after(async () => {
  setColorEnabled(null)
  process.chdir(originalCwd)
  PermissionEngine.setTrusted(false)
  delete process.env.KKCODE_HOME
  await rm(homeDir, { recursive: true, force: true })
  await rm(workDir, { recursive: true, force: true })
})

function baseConfig() {
  return {
    source: {},
    config: {
      provider: { default: PROVIDER, [PROVIDER]: { default_model: "test", timeout_ms: 5000, stream: true, retry_attempts: 1 } },
      agent: { default_mode: "agent", max_steps: 5 },
      permission: { default_policy: "allow", rules: [] },
      session: { max_history: 30, recovery: false },
      tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } },
      usage: { aggregation: ["turn"], budget: {} },
      ui: {}
    }
  }
}

const RICH_STREAM = [
  [
    { type: "thinking", content: "第一行思考\n第二行" },
    { type: "thinking", content: "继续\n" },
    { type: "thinking", content: "尾巴" },
    { type: "text", content: "# 标题\n\n正文 **加粗**" },
    { type: "text", content: " 与 `code` 还有 *斜体*。\n" },
    { type: "text", content: "- 第一项\n- 第二项\n\n```js\nconst x = 1\n```\n" },
    { type: "text", content: "| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n" },
    { type: "usage", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 } },
    { type: "stop", reason: "end_turn" }
  ]
]

const NOTICE_STREAM = [
  [
    { type: "thinking", content: "先想想" },
    { type: "tool_call", call: { id: "tc_1", name: "list", args: { path: "." } } },
    { type: "usage", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
    { type: "stop", reason: "tool_use" }
  ],
  [
    { type: "compaction" },
    { type: "text", content: "继续写\n" },
    { type: "usage", usage: { input: 30, output: 10, cacheRead: 0, cacheWrite: 0 } },
    { type: "stop", reason: "max_tokens" }
  ],
  [
    { type: "text", content: "完成了。\n" },
    { type: "usage", usage: { input: 40, output: 8, cacheRead: 0, cacheWrite: 0 } },
    { type: "stop", reason: "end_turn" }
  ]
]

async function runScenario(name, responses, outputOpts = {}) {
  const bytes = []
  const events = []
  const sessionId = `ses_3a_${name}`
  const unsubscribe = EventBus.subscribe((event) => {
    if (event.sessionId === sessionId) events.push(event)
  })
  let callIndex = 0
  registerProvider(PROVIDER, {
    async request() {
      return { text: "unused", toolCalls: [], usage: {} }
    },
    async *requestStream() {
      const script = responses[Math.min(callIndex++, responses.length - 1)]
      for (const chunk of script) yield chunk
    }
  })
  try {
    const result = await processTurnLoop({
      prompt: "snapshot prompt",
      mode: "agent",
      model: "test",
      providerType: PROVIDER,
      sessionId,
      configState: baseConfig(),
      output: { write: (t) => bytes.push(String(t)), ...outputOpts }
    })
    return { result, bytes: bytes.join(""), events }
  } finally {
    unsubscribe()
  }
}

/** 迁移前就存在的事件类型集合 —— 新增类型不参与逐条比对（它们是纯增量）。 */
const PRE_EXISTING_TYPES = new Set([
  "route.decision", "agent.continuation.interrupted", "agent.continuation.resumed",
  "turn.start", "turn.step.start", "turn.step.finish", "turn.finish", "turn.error",
  "tool.start", "tool.finish", "tool.error", "permission.asked", "permission.decided",
  "review.decision", "mcp.health", "mcp.request", "mcp.reconnect", "mcp.circuit_open",
  "mcp.circuit_close", "session.compacting", "session.compacted", "turn.steer.injected",
  "turn.usage.update", "stream.text.start", "stream.text.delta",
  "stream.thinking.start", "stream.thinking.delta", "subagent.delegated",
  "subagent.settled", "task.settled", "provider.fallback", "provider.retry",
  "longagent.stop.requested"
])

function stableEvents(events) {
  return events
    .filter((event) => PRE_EXISTING_TYPES.has(event.type))
    .map((event) => ({
      type: event.type,
      payload: JSON.parse(JSON.stringify(event.payload ?? {}, (key, value) =>
        key === "durationMs" ? 0 : value))
    }))
}

function stableGoldenEvents(events) {
  return events
    .filter((event) => PRE_EXISTING_TYPES.has(event.type))
    .map((event) => ({
      type: event.type,
      payload: JSON.parse(JSON.stringify(event.payload ?? {}, (key, value) =>
        key === "durationMs" ? 0 : value))
    }))
}

const SCENARIOS = [
  { golden: "color_on_markdown", name: "color_md", stream: RICH_STREAM, color: true, opts: {} },
  { golden: "color_on_norender", name: "color_raw", stream: RICH_STREAM, color: true, opts: { renderMarkdown: false } },
  { golden: "color_on_notices", name: "color_notice", stream: NOTICE_STREAM, color: true, opts: {} },
  { golden: "color_off_markdown", name: "nocolor_md", stream: RICH_STREAM, color: false, opts: {} },
  { golden: "color_off_notices", name: "nocolor_notice", stream: NOTICE_STREAM, color: false, opts: {} }
]

test("渲染快照：output 字节流与迁移前逐字节一致（3a 零行为变更）", async (t) => {
  const golden = JSON.parse(await readFile(FIXTURE_URL, "utf8"))
  for (const scenario of SCENARIOS) {
    await t.test(scenario.golden, async () => {
      setColorEnabled(scenario.color)
      try {
        const { result, bytes, events } = await runScenario(scenario.name, scenario.stream, scenario.opts)
        const expected = golden[scenario.golden]
        assert.equal(bytes, expected.bytes, "output.write 字节流与迁移前不一致")
        assert.equal(result.reply, expected.reply, "回合 reply 与迁移前不一致")
        assert.deepEqual(stableEvents(events), stableGoldenEvents(expected.events),
          "迁移前已存在事件的类型序列与 payload 不一致")
      } finally {
        setColorEnabled(null)
      }
    })
  }
})

test("渲染快照：新增数据事件按语义出现在纯化后的 output 通道上", async () => {
  setColorEnabled(true)
  try {
    const { events } = await runScenario("new_events", NOTICE_STREAM)
    const types = events.map((event) => event.type)

    const toolCall = events.filter((event) => event.type === EVENT_TYPES.STREAM_TOOL_CALL)
    assert.deepEqual(toolCall.map((event) => event.payload), [
      { step: 1, id: "tc_1", name: "list" }
    ], "流内工具调用应作为数据事件出现（迁移前只有 ANSI 字节里的一个换行）")

    const compaction = events.filter((event) => event.type === EVENT_TYPES.STREAM_PROVIDER_COMPACTION)
    assert.deepEqual(compaction.map((event) => event.payload), [{ step: 2 }])

    const streamEnds = events.filter((event) => event.type === EVENT_TYPES.STREAM_END)
    assert.deepEqual(streamEnds.map((event) => event.payload.step), [1, 2, 2],
      "每个 provider 流收尾各一次（含自动续写重试的那次）")

    const autoContinue = events.filter((event) => event.type === EVENT_TYPES.TURN_AUTO_CONTINUE)
    assert.deepEqual(autoContinue.map((event) => event.payload), [
      { step: 2, continueCount: 1, maxContinues: 8 }
    ])

    // 事件相对顺序：tool_call 在 thinking.delta 之后、tool.start 之前
    const idxToolCall = types.indexOf(EVENT_TYPES.STREAM_TOOL_CALL)
    const idxThinkingDelta = types.indexOf(EVENT_TYPES.STREAM_THINKING_DELTA)
    const idxToolStart = types.indexOf(EVENT_TYPES.TOOL_START)
    assert.ok(idxThinkingDelta < idxToolCall && idxToolCall < idxToolStart,
      `事件顺序错乱: ${types.join(" | ")}`)
  } finally {
    setColorEnabled(null)
  }
})

test("渲染快照：turn.validation_skipped 事件语义与相对顺序（直接驱动 render-stream）", async () => {
  // validationSkipped 在 loop 里生于 validator 的 catch（流收尾之后、回合结束之前），
  // mock provider 无法稳定构造那条路径 —— 直接驱动渲染流，钉住与其余四个新事件
  // 对称的事件语义：类型、payload（step + message）、envelope（sessionId/turnId）、
  // 以及它落在 stream.end 之后的相对顺序。
  const events = []
  const render = createRenderStream({
    output: null,
    renderMarkdown: false,
    eventBus: { emit: async (event) => { events.push(event); return event } },
    sessionId: "ses_validation_event",
    turnId: "turn_validation_event"
  })

  render.beginStep(1)
  await render.textDelta(1, "正文\n")
  await render.streamEnd(1)
  await render.validationSkipped(1, "boom")

  assert.deepEqual(events.map((event) => event.type), [
    EVENT_TYPES.STREAM_TEXT_START,
    EVENT_TYPES.STREAM_TEXT_DELTA,
    EVENT_TYPES.STREAM_END,
    EVENT_TYPES.TURN_VALIDATION_SKIPPED
  ], "validation_skipped 应落在 stream.end 之后（与 loop 的 validator catch 位置一致）")
  const event = events.at(-1)
  assert.deepEqual(event.payload, { step: 1, message: "boom" })
  assert.equal(event.sessionId, "ses_validation_event")
  assert.equal(event.turnId, "turn_validation_event")
})

test("字节渲染器：通知模板与迁移前 paint() 输出逐字节一致", async () => {
  const golden = JSON.parse(await readFile(FIXTURE_URL, "utf8"))
  for (const [colorOn, goldens] of [[true, golden.paintGoldens], [false, golden.paintGoldensOff]]) {
    setColorEnabled(colorOn)
    try {
      let out = ""
      const renderer = createStreamByteRenderer({ write: (t) => { out += t }, renderMarkdown: true })
      renderer.beginStep(1)
      renderer.thinkingStart()
      renderer.providerCompaction()
      renderer.autoContinue(1, 8)
      renderer.validationSkipped("boom")
      assert.equal(out, goldens.thinkingBanner + goldens.compaction + goldens.autoContinue + goldens.validationSkipped,
        `通知模板字节（color=${colorOn ? "on" : "off"}）与迁移前不一致`)
    } finally {
      setColorEnabled(null)
    }
  }
})

test("双轨回退：前端未登记渲染器时字节轨静默、数据事件照常（§7.5）", async () => {
  registerStreamByteRenderer(null)
  try {
    const { result, bytes, events } = await runScenario("no_renderer", RICH_STREAM)
    assert.equal(bytes, "", "未登记字节渲染器时旧 output 不应再收到字节")
    assert.equal(result.reply, goldenReplyText())
    const types = new Set(events.map((event) => event.type))
    for (const type of [
      EVENT_TYPES.STREAM_THINKING_START, EVENT_TYPES.STREAM_THINKING_DELTA,
      EVENT_TYPES.STREAM_TEXT_START, EVENT_TYPES.STREAM_TEXT_DELTA, EVENT_TYPES.STREAM_END
    ]) {
      assert.ok(types.has(type), `数据事件 ${type} 不应受字节轨影响`)
    }
  } finally {
    installStreamByteRenderer()
  }
})

function goldenReplyText() {
  return "# 标题\n\n正文 **加粗** 与 `code` 还有 *斜体*。\n- 第一项\n- 第二项\n\n```js\nconst x = 1\n```\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |"
}
