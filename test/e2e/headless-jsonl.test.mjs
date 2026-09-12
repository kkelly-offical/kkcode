import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { HEADLESS_JSONL_EVENT_TYPES, OUTPUT_SCHEMA_VERSION } from "../../src/cli/output-format.mjs"

/**
 * 1.0.0 阶段 5 的硬判据（docs/architecture-kernel-sdk-1.0.0.md §6 阶段 5 完成
 * 判据 1）：headless 机器契约端到端。
 *
 *   kkcode chat --output-format json / stream-json 时：
 *   - stdout 是纯 JSONL：每行恰好一个 JSON 事件、可被 JSON.parse、带
 *     schemaVersion 与 type，且 type 全部命中契约表（HEADLESS_JSONL_EVENT_TYPES）；
 *   - 进度/诊断/提示一律走 stderr，绝不落在 stdout；
 *   - 失败路径同样守纪律：进程级失败时 stdout 零事件、错误文本只在 stderr。
 *
 * provider 是进程内 mock HTTP server（openai-compatible 协议），CLI 以子进程
 * 真实启动 —— 必须用异步 spawn：execFileSync/spawnSync 会卡住本进程事件循环，
 * mock 永远接不到请求（5s 超时假失败，实测教训）。
 */

const CLI = resolve("src/index.mjs")
const NODE = process.execPath

let server
let baseUrl
let home
let workDir

function sseBody(chunks, usage) {
  return [
    ...chunks.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\n`,
    "data: [DONE]\n\n"
  ].join("")
}

before(async () => {
  server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => { body += chunk })
    req.on("end", () => {
      let payload = {}
      try { payload = JSON.parse(body) } catch { /* 非 JSON 请求体按非流式处理 */ }
      if (payload.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.end(sseBody(["Hello", " from mock"], { prompt_tokens: 11, completion_tokens: 7 }))
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Hello from mock" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 7 }
      }))
    })
  })
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
  baseUrl = `http://127.0.0.1:${server.address().port}`

  home = mkdtempSync(join(tmpdir(), "kkcode-jsonl-home-"))
  workDir = mkdtempSync(join(tmpdir(), "kkcode-jsonl-cwd-"))
  writeFileSync(join(home, "config.json"), JSON.stringify({
    mcp: { auto_discover: false, servers: {} },
    skills: { auto_seed: false },
    provider: {
      default: "mock",
      mock: {
        type: "openai-compatible",
        base_url: baseUrl,
        api_key_env: "",
        default_model: "mock-model",
        timeout_ms: 8000,
        retry_attempts: 1
      }
    }
  }))
})

after(async () => {
  await new Promise((resolveClose) => server.close(resolveClose))
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function runCli(args, { env = {}, timeout = 45000 } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(NODE, [CLI, ...args], {
      env: { ...process.env, NO_COLOR: "1", KKCODE_HOME: home, ...env },
      cwd: workDir,
      stdio: ["ignore", "pipe", "pipe"]
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`cli 超时（${timeout}ms）：kkcode ${args.join(" ")}`))
    }, timeout)
    child.on("error", (error) => { clearTimeout(timer); reject(error) })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolveRun({ stdout, stderr, exitCode: code ?? 1 })
    })
  })
}

/** stdout 的每一行都必须是契约内的 JSON 事件；返回解析后的事件数组。 */
function parseJsonlContract(stdout) {
  assert.ok(stdout.endsWith("\n"), "stdout 必须以 \\n 收尾（一行一事件）")
  const lines = stdout.split("\n").filter((line) => line.length > 0)
  return lines.map((line) => {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      assert.fail(`stdout 出现非 JSON 行，JSONL 契约被破坏：${line.slice(0, 200)}`)
    }
    assert.equal(event.schemaVersion, OUTPUT_SCHEMA_VERSION, "每个事件必须带契约 schemaVersion")
    assert.ok(
      HEADLESS_JSONL_EVENT_TYPES.includes(event.type),
      `事件类型 "${event.type}" 不在契约表 ${HEADLESS_JSONL_EVENT_TYPES.join(", ")} 里`
    )
    return event
  })
}

test("e2e headless 契约：--output-format json 的 stdout 是纯 JSONL 且终态事件命中契约表", async () => {
  const { stdout, stderr, exitCode } = await runCli(["chat", "say hi", "--output-format", "json"])
  assert.equal(exitCode, 0, `json 模式应成功退出，stderr：${stderr}`)

  const events = parseJsonlContract(stdout)
  assert.equal(events.length, 1, "json 格式恰好一行：终态结果事件")
  const [result] = events
  assert.equal(result.type, "turn.result")
  assert.equal(result.status, "succeeded")
  assert.equal(result.content, "Hello from mock")
  assert.equal(result.model, "mock-model")
  assert.ok(result.sessionId, "turn.result 必须带 sessionId")
  assert.ok(result.turnId, "turn.result 必须带 turnId")
  assert.equal(result.usage.input, 11)
  assert.equal(result.usage.output, 7)

  // 另一半契约：进度/路由提示全部在 stderr，stdout 一根杂毛都不能有
  assert.ok(stderr.includes("mode:"), "进度输出应走 stderr")
  assert.ok(!stderr.includes('"schemaVersion"'), "stderr 不应携带机器事件（事件只属于 stdout）")
})

test("e2e headless 契约：--output-format stream-json 逐行 delta 且全部命中契约表", async () => {
  const { stdout, stderr, exitCode } = await runCli(["chat", "say hi", "--output-format", "stream-json"])
  assert.equal(exitCode, 0, `stream-json 模式应成功退出，stderr：${stderr}`)

  const events = parseJsonlContract(stdout)
  assert.ok(events.length >= 3, "至少两条 assistant.delta + 一条 turn.result")
  const deltas = events.filter((event) => event.type === "assistant.delta")
  const results = events.filter((event) => event.type === "turn.result")
  assert.equal(results.length, 1, "stream-json 恰好一条终态事件")
  assert.equal(events.at(-1).type, "turn.result", "终态事件必须是最后一行")
  assert.ok(deltas.length >= 2, "增量片段应逐条到达")
  // delta 流与 TUI 字节流同源，末尾带一个渲染换行 —— 拼接比较去掉它
  // （契约文档如实记录：delta 边界无语义，末尾渲染换行不属于正文）。
  assert.equal(
    deltas.map((event) => event.delta).join("").trimEnd(),
    results[0].content,
    "delta 顺序拼接必须等于终态 content"
  )
  assert.equal(results[0].status, "succeeded")
})

test("e2e headless 契约：进程级失败时 stdout 保持纯 JSONL（零事件），错误只在 stderr", async () => {
  const emptyHome = mkdtempSync(join(tmpdir(), "kkcode-jsonl-empty-home-"))
  try {
    // 空 home：没有配置任何 provider，chat 在回合开始前就失败
    const { stdout, stderr, exitCode } = await runCli(
      ["chat", "say hi", "--output-format", "json"],
      { env: { KKCODE_HOME: emptyHome } }
    )
    assert.notEqual(exitCode, 0, "无 provider 必须非零退出")
    // stdout 为零行 —— 空流是合法 JSONL；错误文本是诊断，属于 stderr
    assert.equal(stdout, "", "失败路径上 stdout 不得出现任何非事件字节")
    assert.ok(stderr.length > 0, "错误诊断必须走 stderr")
    assert.ok(stderr.includes("provider"), "stderr 应说明失败原因")
  } finally {
    rmSync(emptyHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
