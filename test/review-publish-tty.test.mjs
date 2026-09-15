import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { PassThrough } from "node:stream"
import { createBranchReviewPromptHandlers, createReviewCommand } from "../src/commands/review.mjs"
import { defaultPermissionPromptChannel } from "../src/kernel/permission/prompt.mjs"
import { trustFilePath } from "../src/storage/paths.mjs"

/**
 * M21 — review branch --publish 的 TTY 审批接线（M19 审计的唯一漏网）。
 *
 * 修复前 review.mjs 的 branch action 调 createKernel({cwd}) 不传 handlers，
 * publish 前的 defaultPermissionEngine.check({tool:"github_publish", risk:7})
 * 在交互式 TTY 上也被确定性 deny —— 用户永远看不到审批弹窗。本文件钉住三层：
 *
 * 1. createBranchReviewPromptHandlers 的接线决策：TTY 才出 handler、--json 时
 *    提示写 stderr（stdout 的机器可读契约不被审批行污染）、非 TTY 返回 null。
 * 2. 端到端（假 handler 装进进程级默认通道，正是 createKernel({handlers}) 经
 *    2b 桥安装的位置）：TTY + 无 allow 规则 → --publish 走 handler 审批，
 *    allow_once 后真正发出 GitHub 评论。
 * 3. 对照组：无 handler（非 TTY）保持 3b 确定性 deny；未授信工作区无 --trust
 *    时抛 "workspace not trusted"，--trust 走既有信任流程（落盘 trust 文件）。
 */

const PR_URL = "https://github.com/example/repo/pull/32"

const SAFE_DIFF = [
  "diff --git a/app.mjs b/app.mjs",
  "index 77aabb1..88ccdd2 100644",
  "--- a/app.mjs",
  "+++ b/app.mjs",
  "@@ -1 +1,2 @@",
  " export const value = 1",
  "+export const next = value + 1"
].join("\n")

function makeTtyStreams() {
  const input = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let outWritten = ""
  let errWritten = ""
  stdout.on("data", (chunk) => { outWritten += chunk.toString("utf8") })
  stderr.on("data", (chunk) => { errWritten += chunk.toString("utf8") })
  return { input, stdout, stderr, readOut: () => outWritten, readErr: () => errWritten }
}

test("接线决策：非 TTY 返回 null（保持确定性收口），TTY 返回审批/提问 handler", () => {
  const streams = makeTtyStreams()
  assert.equal(
    createBranchReviewPromptHandlers({}, { input: streams.input, stdout: streams.stdout }),
    null
  )
  const handlers = createBranchReviewPromptHandlers({}, {
    input: streams.input,
    stdout: streams.stdout,
    isTTY: true
  })
  assert.equal(typeof handlers?.onPermissionPrompt, "function")
  assert.equal(typeof handlers?.onQuestionPrompt, "function")
})

test("接线决策：审批提示默认写 stdout，--json 时写 stderr 保 stdout 契约", async () => {
  const plain = makeTtyStreams()
  const plainHandlers = createBranchReviewPromptHandlers({}, {
    input: plain.input,
    stdout: plain.stdout,
    stderr: plain.stderr,
    isTTY: true
  })
  const plainPending = plainHandlers.onPermissionPrompt({ tool: "github_publish", sessionId: "s", risk: 7 })
  plain.input.write("1\n")
  assert.equal(await plainPending, "allow_once")
  assert.match(plain.readOut(), /Permission requested for tool: github_publish/)
  assert.equal(plain.readErr(), "")

  const json = makeTtyStreams()
  const jsonHandlers = createBranchReviewPromptHandlers({ json: true }, {
    input: json.input,
    stdout: json.stdout,
    stderr: json.stderr,
    isTTY: true
  })
  const jsonPending = jsonHandlers.onPermissionPrompt({ tool: "github_publish", sessionId: "s", risk: 7 })
  json.input.write("1\n")
  assert.equal(await jsonPending, "allow_once")
  assert.match(json.readErr(), /Permission requested for tool: github_publish/)
  assert.equal(json.readOut(), "")
})

function jsonResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data }
}

/**
 * 在临时 cwd + 临时 KKCODE_HOME 里跑完整的 `review branch --pr … --publish` action。
 * fetch 全量打桩：GitHub PR/对比/checks/评论 + OpenAI 兼容的评审模型端点。
 * handler 参数直接装进 defaultPermissionPromptChannel —— 与 TTY 上
 * createKernel({handlers}) 经 2b 桥安装的是同一个槽位（kernel.mjs:220-225）。
 */
async function runBranchPublish({ handler = null, extraArgs = [] } = {}) {
  // realpath 对齐 process.cwd() 的物理路径：macOS 上 mkdtemp 返回
  // /var/folders/...，chdir 后 process.cwd() 是 /private/var/folders/...，
  // 而 workspace trust 以路径 SHA256 为键，符号链接路径会让 hash 错位。
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "kkcode-review-publish-cwd-")))
  const home = await realpath(await mkdtemp(join(tmpdir(), "kkcode-review-publish-home-")))
  await writeFile(join(home, "github-token.json"), JSON.stringify({ token: "test-token", login: "kkcode-user" }), "utf8")
  await writeFile(join(cwd, "kkcode.config.json"), JSON.stringify({
    mcp: { auto_discover: false, servers: {} },
    skills: { auto_seed: false },
    provider: {
      default: "openai",
      openai: {
        // https：内核拒绝经明文 http 传输凭据（provider/security.mjs）
        base_url: "https://review-test.invalid/v1",
        api_key_env: "KKCODE_REVIEW_TEST_API_KEY",
        default_model: "fake-review-model"
      }
    }
  }), "utf8")

  const requests = []
  const stdoutChunks = []
  const stderrChunks = []
  const originalFetch = globalThis.fetch
  const originalCwd = process.cwd()
  const originalHome = process.env.KKCODE_HOME
  const originalApiKey = process.env.KKCODE_REVIEW_TEST_API_KEY
  const originalLog = console.log
  const originalError = console.error

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url)
    const method = String(init.method || "GET").toUpperCase()
    requests.push({ url: href, method, init })
    const accept = init.headers?.Accept || init.headers?.accept || ""
    if (href.startsWith("https://review-test.invalid/")) {
      return jsonResponse({
        choices: [{ message: { content: "{\"findings\":[]}" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      })
    }
    if (href === "https://api.github.com/repos/example/repo/pulls/32") {
      if (accept.includes("application/vnd.github.v3.diff")) {
        return { ok: true, status: 200, text: async () => SAFE_DIFF }
      }
      return jsonResponse({
        html_url: PR_URL,
        title: "Review",
        state: "open",
        draft: false,
        changed_files: 1,
        base: { ref: "main", sha: "a".repeat(40) },
        head: { ref: "feature", sha: "b".repeat(40) }
      })
    }
    if (href.includes("/compare/")) return jsonResponse({ merge_base_commit: { sha: "c".repeat(40) } })
    if (href.includes("/check-runs")) return jsonResponse({ total_count: 0, check_runs: [] })
    if (href.includes("/status")) return jsonResponse({ total_count: 0, statuses: [] })
    if (href.includes("/issues/32/comments")) {
      if (method === "GET") return jsonResponse([])
      return jsonResponse({ id: 9001, html_url: `${PR_URL}#issuecomment-9001` }, 201)
    }
    throw new Error(`unexpected fetch in test: ${href}`)
  }
  console.log = (...args) => { stdoutChunks.push(args.join(" ")) }
  console.error = (...args) => { stderrChunks.push(args.join(" ")) }
  process.env.KKCODE_HOME = home
  process.env.KKCODE_REVIEW_TEST_API_KEY = "test-key"
  process.chdir(cwd)
  defaultPermissionPromptChannel.setPermissionPromptHandler(handler)

  try {
    await createReviewCommand().parseAsync(["node", "kkcode", "branch", "--pr", PR_URL, "--publish", ...extraArgs])
    const exitCode = process.exitCode ?? 0
    let trust = null
    try {
      trust = JSON.parse(await readFile(trustFilePath(resolve(cwd)), "utf8"))
    } catch {
      trust = null
    }
    let state = null
    try {
      state = JSON.parse(await readFile(join(cwd, ".kkcode", "review-state.json"), "utf8"))
    } catch {
      state = null
    }
    return {
      exitCode,
      requests,
      trust,
      state,
      stdout: stdoutChunks.join("\n"),
      stderr: stderrChunks.join("\n")
    }
  } finally {
    defaultPermissionPromptChannel.setPermissionPromptHandler(null)
    process.exitCode = undefined
    process.chdir(originalCwd)
    globalThis.fetch = originalFetch
    console.log = originalLog
    console.error = originalError
    if (originalHome === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = originalHome
    if (originalApiKey === undefined) delete process.env.KKCODE_REVIEW_TEST_API_KEY
    else process.env.KKCODE_REVIEW_TEST_API_KEY = originalApiKey
    await rm(cwd, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
}

test("TTY + 无 allow 规则 → --publish 走 handler 审批，allow_once 后评论真正发出", async () => {
  const prompts = []
  const result = await runBranchPublish({
    handler: async (request) => {
      prompts.push(request)
      return "allow_once"
    },
    extraArgs: ["--trust"]
  })
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`)
  // 审批 handler 被调用一次，带上的正是 publish 检查的工具/风险/目标
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].tool, "github_publish")
  assert.equal(prompts[0].risk, 7)
  assert.equal(prompts[0].pattern, PR_URL)
  assert.match(String(prompts[0].reason), /pull request review comment/)
  // 审批放行后真正执行了发布：先列评论，再 POST 新评论
  const commentRequests = result.requests.filter((r) => r.url.includes("/issues/32/comments"))
  assert.deepEqual(commentRequests.map((r) => r.method), ["GET", "POST"])
  assert.match(String(commentRequests[1].init.body), /kkcode-review:example\/repo#32/)
  // 发布结果落进 review-state，供 gate/waive 复查
  assert.equal(result.state?.branchReport?.publish?.status, "created")
  assert.equal(result.state?.branchReport?.publish?.commentId, 9001)
  // --trust 走了既有信任流程：trust 文件落盘
  assert.equal(result.trust?.trusted, true)
})

test("对照：无 handler（非 TTY）→ --publish 确定性 deny，绝不触碰 GitHub 评论接口", async () => {
  const result = await runBranchPublish({ handler: null, extraArgs: ["--trust"] })
  assert.equal(result.exitCode, 1)
  assert.match(result.stderr, /no approval handler injected by the host/)
  assert.equal(result.requests.some((r) => r.url.includes("/issues/")), false)
  assert.equal(result.state?.branchReport?.publish ?? null, null)
})

test("对照：未授信工作区且无 --trust → workspace not trusted，handler 都轮不到", async () => {
  const prompts = []
  const result = await runBranchPublish({
    handler: async (request) => {
      prompts.push(request)
      return "allow_once"
    }
  })
  assert.equal(result.exitCode, 1)
  assert.match(result.stderr, /workspace not trusted/)
  assert.equal(prompts.length, 0)
  assert.equal(result.requests.some((r) => r.url.includes("/issues/")), false)
  assert.equal(result.trust, null)
})

test("--json 下 stdout 保持机器可读：审批放行后报告 JSON 含 publish 结果", async () => {
  const result = await runBranchPublish({
    handler: async () => "allow_once",
    extraArgs: ["--trust", "--json"]
  })
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`)
  const report = JSON.parse(result.stdout)
  assert.equal(report.schema, "kk.review.v1")
  assert.equal(report.publish?.status, "created")
})
