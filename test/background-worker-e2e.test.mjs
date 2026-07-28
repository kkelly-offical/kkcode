import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import http from "node:http"
import { execFileSync } from "node:child_process"
import { BackgroundManager } from "../src/orchestration/background-manager.mjs"
import { EventBus } from "../src/core/events.mjs"
import { EVENT_TYPES } from "../src/core/constants.mjs"
import { appendAssistantMessage, appendUserMessage, flushNow, touchSession } from "../src/session/store.mjs"
import { readJson } from "../src/storage/json-store.mjs"
import { sessionDataPath, sessionIndexPath } from "../src/storage/paths.mjs"
import { persistTrust } from "../src/permission/workspace-trust.mjs"

let home = ""
let project = ""
let oldCwd = process.cwd()
let server = null
let serverUrl = ""
let requestCount = 0

function git(...args) {
  return execFileSync("git", args, {
    cwd: project,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  })
}

// 用例可以覆盖它来编排逐次回复（例如先发一次工具调用再收尾）。
// 返回 null 表示走默认行为。
let mockResponder = null

async function startMockOpenAIServer() {
  requestCount = 0
  mockResponder = null
  server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/chat/completions") {
      res.statusCode = 404
      res.end("not found")
      return
    }
    requestCount += 1

    const scripted = mockResponder ? await mockResponder(requestCount) : null
    if (scripted) {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify(scripted))
      return
    }

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
  throw new Error(`timeout waiting for task state. last status=${finalTask?.status || "missing"} error=${finalTask?.error || ""} reply=${String(finalTask?.result?.reply || "").slice(0, 200)}`)
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kkcode-bg-e2e-home-"))
  project = await mkdtemp(join(tmpdir(), "kkcode-bg-e2e-project-"))
  oldCwd = process.cwd()
  process.chdir(project)
  process.env.KKCODE_HOME = home
  await startMockOpenAIServer()
  await persistTrust(project)

  await writeFile(
    join(project, "kkcode.config.json"),
    JSON.stringify(
      {
        provider: {
          default: "local",
          local: {
            type: "openai-compatible",
            base_url: serverUrl,
            api_key_env: "",
            default_model: "test-model",
            stream: false,
            timeout_ms: 15000,
            retry_attempts: 1,
            retry_base_delay_ms: 100
          }
        },
        permission: {
          level: "accept-edits",
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

  git("init")
  git("config", "user.email", "test@test.com")
  git("config", "user.name", "Test User")
  git("config", "core.autocrlf", "false")
  await writeFile(join(project, "README.md"), "worktree test\n", "utf8")
  git("add", ".")
  git("commit", "-m", "initial commit")
})

afterEach(async () => {
  process.chdir(oldCwd)
  await stopMockServer()
  delete process.env.KKCODE_HOME
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  await rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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

// 0.8.0：跨进程的终态广播。这条用例存在的理由是父子进程的观察差：
// worker 是在**它自己的进程**里把 checkpoint 写成 completed 的，父进程的
// patchTask 从没见过那次跨越 —— 换句话说，父进程唯一可能知道任务完成的
// 途径就是 child 的 exit 回调加一次回读复核。而 exit 只说明「进程没了」，
// 拿退出码当终态会把崩溃报成完成，所以复核不能省。
//
// 单进程的 inline 任务测不到这条：那里 patchTask 自己就看见了跨越。
test("worker 在自己进程里落地：父进程靠退出后复核广播 TASK_SETTLED，且只广播一次", async () => {
  const config = {
    background: { mode: "worker_process", max_parallel: 1, worker_timeout_ms: 30000 }
  }
  // 默认 mock 会在第一次请求上睡 5 秒；这条用例只关心落地通道。
  mockResponder = () => ({
    id: "chatcmpl-settled",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "background completed" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 }
  })

  const settled = []
  const unsubscribe = EventBus.subscribe((event) => {
    if (event.type === EVENT_TYPES.TASK_SETTLED) settled.push(event)
  })

  try {
    const task = await BackgroundManager.launchDelegateTask({
      description: "e2e settled broadcast",
      payload: {
        workerType: "delegate_task",
        cwd: project,
        prompt: "run once",
        parentSessionId: "ses_parent_settled",
        subSessionId: `ses_sub_settled_${Date.now()}`,
        providerType: "local",
        model: "test-model"
      },
      config
    })

    await waitFor(task.id, (it) => it.status === "completed", { config, timeoutMs: 30000 })

    // checkpoint 先落地，exit 回调随后到 —— 等的是广播，不是状态。
    const deadline = Date.now() + 15000
    while (settled.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(settled.length, 1, "worker 落地必须广播一次")
    const payload = settled[0].payload
    assert.equal(payload.id, task.id)
    // "exited" 是进程语义，绝不能作为任务状态漏出去
    assert.equal(payload.status, "completed")
    assert.equal(settled[0].sessionId, "ses_parent_settled")

    // 再 tick 几次：两条观察路径都不该产生第二条
    for (let i = 0; i < 3; i++) await BackgroundManager.tick(config)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(settled.length, 1, "同一次落地不得广播两次")
  } finally {
    unsubscribe()
  }
})

test("background fork_context task inherits parent session transcript", async () => {
  const config = {
    background: {
      mode: "worker_process",
      max_parallel: 1,
      worker_timeout_ms: 30000
    }
  }

  await touchSession({ sessionId: "ses_parent_bg_fork", mode: "agent", model: "test-model", providerType: "local", cwd: project })
  await appendUserMessage("ses_parent_bg_fork", "parent background user context")
  await appendAssistantMessage("ses_parent_bg_fork", "parent background assistant context")
  await flushNow()

  const subSessionId = `ses_bg_fork_${Date.now()}`
  const task = await BackgroundManager.launchDelegateTask({
    description: "e2e fork-context delegate task",
    payload: {
      workerType: "delegate_task",
      cwd: project,
      prompt: "run once",
      parentSessionId: "ses_parent_bg_fork",
      subSessionId,
      executionMode: "fork_context",
      providerType: "local",
      model: "test-model"
    },
    config
  })

  const completed = await waitFor(task.id, (it) => it.status === "completed", { config, timeoutMs: 30000 })
  assert.equal(completed.status, "completed")
  assert.equal(completed.result?.execution_mode, "fork_context")
  assert.equal(completed.result?.parent_session_id, "ses_parent_bg_fork")

  const sessionIndex = await readJson(sessionIndexPath(), { sessions: {} })
  const childSession = sessionIndex.sessions?.[subSessionId]
  const childData = await readJson(sessionDataPath(subSessionId), { messages: [] })

  assert.equal(childSession?.parentSessionId, "ses_parent_bg_fork")
  assert.equal(childSession?.forkFrom, "ses_parent_bg_fork")
  assert.deepEqual(
    childData.messages.map((message) => message.content),
    [
      "parent background user context",
      "parent background assistant context",
      "run once",
      "background completed"
    ]
  )
})

test("background delegate can run inside a local detached worktree and auto-clean when unchanged", async () => {
  const config = {
    background: {
      mode: "worker_process",
      max_parallel: 1,
      worker_timeout_ms: 30000
    }
  }

  const task = await BackgroundManager.launchDelegateTask({
    description: "e2e worktree delegate task",
    payload: {
      workerType: "delegate_task",
      cwd: project,
      prompt: "run once",
      parentSessionId: "ses_parent_bg_worktree",
      subSessionId: `ses_bg_worktree_${Date.now()}`,
      isolation: "worktree",
      executionMode: "fresh_agent",
      providerType: "local",
      model: "test-model"
    },
    config
  })

  const completed = await waitFor(task.id, (it) => it.status === "completed", { config, timeoutMs: 30000 })
  assert.equal(completed.result?.isolation, "worktree")
  assert.equal(completed.result?.worktree_preserved, false)
  assert.equal(completed.result?.worktree_path, null)
})

test("background delegate rejects invalid input before worktree or provider startup", async () => {
  const config = {
    background: {
      mode: "worker_process",
      max_parallel: 1,
      worker_timeout_ms: 30000
    }
  }

  const task = await BackgroundManager.launchDelegateTask({
    description: "e2e worktree error cleanup",
    payload: {
      workerType: "delegate_task",
      cwd: project,
      prompt: "fail once",
      parentSessionId: "ses_parent_bg_worktree_error",
      subSessionId: `ses_bg_worktree_error_${Date.now()}`,
      isolation: "worktree",
      executionMode: "fresh_agent",
      allowQuestion: true,
      providerType: "local",
      model: "test-model"
    },
    config
  })

  const failed = await waitFor(task.id, (it) => it.status === "error", { config, timeoutMs: 30000 })
  assert.equal(failed.status, "error")
  assert.equal(requestCount, 0, "invalid background input must fail before provider or extension startup")
  assert.equal(
    git("worktree", "list", "--porcelain").includes(`kkcode-worktree-${task.id}-`),
    false
  )
})

test("background delegate cleans a detached worktree after a post-setup error", async () => {
  const config = {
    background: {
      mode: "worker_process",
      max_parallel: 1,
      worker_timeout_ms: 30000
    }
  }

  const task = await BackgroundManager.launchDelegateTask({
    description: "e2e worktree runtime error cleanup",
    payload: {
      workerType: "delegate_task",
      cwd: project,
      prompt: "fail after worktree setup",
      parentSessionId: "ses_missing_bg_worktree_runtime_error",
      subSessionId: `ses_bg_worktree_runtime_error_${Date.now()}`,
      isolation: "worktree",
      executionMode: "fork_context",
      providerType: "local",
      model: "test-model"
    },
    config
  })

  const failed = await waitFor(task.id, (it) => it.status === "error", { config, timeoutMs: 30000 })
  assert.equal(failed.status, "error")
  assert.equal(
    git("worktree", "list", "--porcelain").includes(`kkcode-worktree-${task.id}-`),
    false
  )
})

// 0.5.8：这条用例存在的唯一理由，是此前整个后台通道的工具调用都是坏的而
// 测试全绿。worker 是独立进程入口，却从不调用 PermissionEngine.setTrusted()，
// 而 engine.check() 第一行就在信任为假时抛错 —— 每次工具调用都被拒、被吞成
// tool error、子智能体降级为纯文本作答，任务照样标 completed。原来的 mock
// 只回纯文本，永远走不到权限检查那一步，所以这个 bug 活了下来。
//
// 因此这里必须发一次真实的工具调用，并断言产物真的落到磁盘上 —— 只断言
// 任务状态是不够的，那正是当年漏掉它的原因。
test("background worker can actually use tools: a delegated write lands on disk", async () => {
  const config = {
    background: { mode: "worker_process", max_parallel: 1, worker_timeout_ms: 30000 }
  }

  // 默认的 e2e 配置关掉了全部内建工具且 max_steps=1，工具调用无从谈起。
  const raw = JSON.parse(await readFile(join(project, "kkcode.config.json"), "utf8"))
  raw.tool.sources.builtin = true
  raw.agent.max_steps = 3
  await writeFile(join(project, "kkcode.config.json"), `${JSON.stringify(raw, null, 2)}\n`, "utf8")

  const target = "delegated-artifact.txt"
  const contents = "written by the background worker\n"
  mockResponder = (count) => {
    if (count === 1) {
      return {
        id: "chatcmpl-tool",
        choices: [{
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_write_1",
              type: "function",
              function: { name: "write", arguments: JSON.stringify({ path: target, content: contents }) }
            }]
          }
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      }
    }
    return {
      id: "chatcmpl-done",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "wrote the file" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  }

  const task = await BackgroundManager.launchDelegateTask({
    description: "e2e delegated tool call",
    payload: {
      workerType: "delegate_task",
      cwd: project,
      prompt: `write ${target}`,
      parentSessionId: "ses_parent_tooluse",
      subSessionId: `ses_sub_tooluse_${Date.now()}`,
      providerType: "local",
      model: "test-model"
    },
    config
  })

  const done = await waitFor(task.id, (it) => ["completed", "error"].includes(it.status), { config, timeoutMs: 30000 })
  assert.equal(done.status, "completed", `task failed: ${done.error || ""}`)

  // 核心断言：产物真的存在。信任标志没设时这里会 ENOENT。
  const written = await readFile(join(project, target), "utf8")
  assert.equal(written, contents)

  assert.ok(Number(done.result?.tool_events || 0) > 0, "工具事件计数必须非零")
  assert.doesNotMatch(String(done.result?.reply || ""), /not trusted/i)
})
