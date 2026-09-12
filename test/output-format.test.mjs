import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import {
  createOutputReporter,
  resolveOutputFormat,
  toPublicResult,
  HEADLESS_JSONL_EVENTS,
  HEADLESS_JSONL_EVENT_TYPES,
  OUTPUT_SCHEMA_VERSION
} from "../src/cli/output-format.mjs"

function sink() {
  let value = ""
  return { write(chunk) { value += chunk }, read() { return value } }
}

test("non-TTY defaults to stable text while TTY keeps legacy display", () => {
  assert.equal(resolveOutputFormat(null, { stdoutIsTTY: false }), "text")
  assert.equal(resolveOutputFormat(null, { stdoutIsTTY: true }), "legacy")
  assert.throws(() => resolveOutputFormat("xml"), /invalid output format/)
})

test("text output keeps progress off stdout", () => {
  const stdout = sink()
  const stderr = sink()
  const reporter = createOutputReporter("text", { stdout, stderr })
  reporter.progress("thinking")
  reporter.finish({ reply: "done", sessionId: "s", turnId: "t" })
  assert.equal(stdout.read(), "done\n")
  assert.equal(stderr.read(), "thinking\n")
})

test("public JSON result has a versioned stable shape", () => {
  assert.deepEqual(toPublicResult({
    reply: "ok",
    sessionId: "s",
    turnId: "t",
    mode: "agent",
    model: "k3",
    tokenMeter: { turn: { input: 2, output: 3 }, estimated: false }
  }), {
    schemaVersion: "1",
    sessionId: "s",
    turnId: "t",
    status: "succeeded",
    mode: "agent",
    model: "k3",
    content: "ok",
    usage: { input: 2, output: 3, estimated: false },
    cost: 0,
    toolResults: [],
    warnings: [],
    error: null
  })
})

// --- 1.0.0 阶段 5：headless JSONL 机器契约（docs/headless-jsonl-contract.md） ---

test("契约表冻结且稳定性标记合法 —— 表即契约面，不允许运行期被改", () => {
  assert.ok(Object.isFrozen(HEADLESS_JSONL_EVENTS))
  assert.ok(Object.isFrozen(HEADLESS_JSONL_EVENT_TYPES))
  assert.deepEqual([...HEADLESS_JSONL_EVENT_TYPES].sort(), ["assistant.delta", "turn.result"])
  for (const type of HEADLESS_JSONL_EVENT_TYPES) {
    assert.ok(
      ["stable", "experimental"].includes(HEADLESS_JSONL_EVENTS[type].stability),
      `${type} 必须标 stable 或 experimental`
    )
  }
})

test("json 格式 stdout 恰好一行 turn.result 事件，其余通道全走 stderr", () => {
  const stdout = sink()
  const stderr = sink()
  const reporter = createOutputReporter("json", { stdout, stderr })
  reporter.progress("路由中")
  reporter.warning("pricing warning: x")
  reporter.delta("json 模式不出 delta")
  reporter.finish({ reply: "done", sessionId: "s", turnId: "t" })

  const lines = stdout.read().split("\n").filter(Boolean)
  assert.equal(lines.length, 1, "json 格式 stdout 必须恰好一行")
  const event = JSON.parse(lines[0])
  assert.ok(HEADLESS_JSONL_EVENT_TYPES.includes(event.type), "事件类型必须命中契约表")
  assert.equal(event.type, "turn.result")
  assert.equal(event.schemaVersion, OUTPUT_SCHEMA_VERSION)
  assert.equal(event.content, "done")
  assert.equal(event.status, "succeeded")
  assert.ok(stderr.read().includes("路由中"), "进度必须走 stderr")
  assert.ok(stderr.read().includes("pricing warning"), "警告必须走 stderr")
})

test("stream-json 格式 delta 与终态都是带类型的契约事件", () => {
  const stdout = sink()
  const stderr = sink()
  const reporter = createOutputReporter("stream-json", { stdout, stderr })
  reporter.progress("路由中")
  reporter.delta("Hel")
  reporter.delta("lo")
  reporter.finish({ reply: "Hello", sessionId: "s", turnId: "t" })

  const events = stdout.read().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  assert.deepEqual(events.map((event) => event.type), ["assistant.delta", "assistant.delta", "turn.result"])
  for (const event of events) {
    assert.equal(event.schemaVersion, OUTPUT_SCHEMA_VERSION)
    assert.ok(HEADLESS_JSONL_EVENT_TYPES.includes(event.type))
  }
  assert.equal(events[2].content, "Hello")
  assert.ok(!stderr.read().includes('"type"'), "事件只属于 stdout")
})

test("契约文档与代码同步：docs/headless-jsonl-contract.md 必须覆盖全部事件类型与版本号", () => {
  const docPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "headless-jsonl-contract.md")
  const doc = readFileSync(docPath, "utf8")
  for (const type of HEADLESS_JSONL_EVENT_TYPES) {
    assert.ok(doc.includes(type), `契约文档缺少事件类型 ${type} —— 表与文档必须同源`)
    assert.ok(doc.includes(HEADLESS_JSONL_EVENTS[type].stability), `契约文档缺少 ${type} 的稳定性标记`)
  }
  assert.ok(doc.includes(`"${OUTPUT_SCHEMA_VERSION}"`), "契约文档必须写明当前 schemaVersion")
})
