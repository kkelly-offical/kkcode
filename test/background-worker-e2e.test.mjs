import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import http from "node:http"
import { BackgroundManager } from "../src/orchestration/background-manager.mjs"

let home = ""
let project = ""
let oldCwd = process.cwd()
let server = null
let serverUrl = ""
let requestCount = 0

async function startMockOpenAIServer() {
  requestCount = 0
  server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/chat/completions") {
      res.statusCode = 404
      res.end("not found")
      return
    }
    requestCount += 1

    if (requestCount === 1) {
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }

    res.setHeader("content-type", "application/json")
    res.end(
      JSON.stringify({
        id: "chatcmpl-test",
        choices: [{ index: 0, message: { role: "assistant", content: "background completed" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      })
    )
  })

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  serverUrl = `http://127.0.0.1:${address.port}`
}

async function stopMockServer() {
  if (!server) return
  await new Promise((resolve) => server.close(() => resolve()))
  server = null
}

async function waitFor(taskId, predicate, { timeoutMs = 20000, tickMs = 200, config = {} } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await BackgroundManager.tick(config)
    const task = await BackgroundManager.get(taskId)
    if (task && predicate(task)) return task
    await new Promise((resolve) => setTimeout(resolve, tickMs))
  }
  const finalTask = await BackgroundManager.get(taskId)
  throw new Error(`timeout waiting for task state. last status=${finalTask?.status || "missing"}`)
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kkcode-bg-e2e-home-"))
  project = await mkdtemp(join(tmpdir(), "kkcode-bg-e2e-project-"))
  oldCwd = process.cwd()
  process.chdir(project)
  process.env.KKCODE_HOME = home
  process.env.OPENAI_API_KEY = "test-key"
  await startMockOpenAIServer()

  await writeFile(
    join(project, "kkcode.config.json"),
    JSON.stringify(
      {
        provider: {
          default: "local",
          local: {
            type: "openai-compatible",
            base_url: serverUrl,
            api_key_env: "OPENAI_API_KEY",
            default_model: "test-model",
            stream: false,
            timeout_ms: 15000,
            retry_attempts: 1,
            retry_base_delay_ms: 100
          }
        },
        permission: {
          default_policy: "allow",
          non_tty_default: "allow_once",
          rules: []
        },
        agent: {
          max_steps: 1
        },
        tool: {
          sources: { builtin: false, local: false, plugin: false, mcp: false }
        },
        session: {
          max_history: 10,
          recovery: true
        },
        background: {
          mode: "worker_process",
          max_parallel: 1,
          worker_timeout_ms: 30000
        },
        ui: {
          markdown_render: false
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  )
})

afterEach(async () => {
  process.chdir(oldCwd)
  await stopMockServer()
  delete process.env.KKCODE_HOME
  delete process.env.OPENAI_API_KEY
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

test("background worker kill -> interrupted -> retry -> completed", async () => {
  const config = {
    background: {
      mode: "worker_process",
      max_parallel: 1,
      worker_timeout_ms: 30000
    }
  }

  const task = await BackgroundManager.launchDelegateTask({
    description: "e2e delegate task",
    payload: {
      workerType: "delegate_task",
      cwd: project,
      prompt: "run once",
      parentSessionId: "ses_parent_bg",
      subSessionId: `ses_sub_${Date.now()}`,
      providerType: "local",
      model: "test-model"
    },
    config
  })

  const running = await waitFor(task.id, (it) => it.status === "running" && Number.isInteger(it.workerPid), { config })
  assert.equal(running.status, "running")
  assert.ok(Number.isInteger(running.workerPid))

  process.kill(running.workerPid)

  const interrupted = await waitFor(task.id, (it) => it.status === "interrupted", { config })
  assert.equal(interrupted.status, "interrupted")

  const retried = await BackgroundManager.retry(task.id, config)
  assert.ok(retried)
  assert.equal(retried.attempt, 2)

  const completed = await waitFor(task.id, (it) => it.status === "completed", { config, timeoutMs: 30000 })
  assert.equal(completed.status, "completed")
  assert.equal(completed.result?.reply, "background completed")
})
