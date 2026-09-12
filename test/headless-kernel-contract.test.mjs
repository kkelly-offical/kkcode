import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createKernel } from "../src/kernel/index.mjs"
import { registerProvider } from "../src/provider/router.mjs"
import { defaultPermissionPromptChannel } from "../src/kernel/permission/prompt.mjs"
import { defaultQuestionPromptChannel } from "../src/kernel/tool/question-prompt.mjs"
import { checkWorkspaceTrust } from "../src/kernel/permission/workspace-trust.mjs"

/**
 * 1.0.0 阶段 3b 的硬判据（§6 阶段 3 完成判据 3，M3 耦合点 15）：内核不碰 TTY。
 *
 *   - 未注入 prompt handler 的 kernel 遇到需要审批的工具时，收到**确定性
 *     deny 事件**（permission.asked → permission.decided: deny），而不是
 *     阻塞读 stdin；
 *   - 注入了 handler 的宿主照常问答（对照组，证明通道本身没坏）；
 *   - 提问通道与工作区信任探测同样不再自开终端行读取：无 handler/prompt
 *     注入时全部走确定性收口。
 */

const PROVIDER = "mock_headless_contract"

let homeDir
let workDir
let originalCwd

before(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "kkcode-headless-home-"))
  workDir = await mkdtemp(join(tmpdir(), "kkcode-headless-cwd-"))
  process.env.KKCODE_HOME = homeDir
  originalCwd = process.cwd()
  process.chdir(workDir)
})

after(async () => {
  process.chdir(originalCwd)
  delete process.env.KKCODE_HOME
  await rm(homeDir, { recursive: true, force: true })
  await rm(workDir, { recursive: true, force: true })
})

function headlessConfig() {
  return {
    source: {},
    config: {
      provider: {
        default: PROVIDER,
        [PROVIDER]: { default_model: "mock-model", timeout_ms: 5000, stream: false, retry_attempts: 1 }
      },
      agent: { default_mode: "agent", max_steps: 3 },
      // manual 档：edit 能力（write 工具）必须询问 —— 这正是会卡住 stdin 的路径
      permission: { level: "manual", rules: [] },
      session: { max_history: 10, recovery: false },
      tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } },
      usage: { aggregation: ["turn"], budget: {} },
      ui: { markdown_render: false }
    }
  }
}

function registerWriteThenReply() {
  let callIndex = 0
  registerProvider(PROVIDER, {
    async request() {
      callIndex += 1
      if (callIndex === 1) {
        return {
          text: "",
          toolCalls: [{ id: "tc_write_1", name: "write", args: { path: "should-not-exist.txt", content: "no" } }],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }
        }
      }
      return { text: "明白了，不动文件。", toolCalls: [], usage: { input: 12, output: 6, cacheRead: 0, cacheWrite: 0 } }
    },
    async *requestStream() {
      callIndex += 1
      if (callIndex === 1) {
        yield { type: "tool_call", call: { id: "tc_write_1", name: "write", args: { path: "should-not-exist.txt", content: "no" } } }
      } else {
        yield { type: "text", content: "明白了，不动文件。" }
      }
      yield { type: "usage", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }
    }
  })
}

/** 确定性证明：回合必须在时限内完成 —— 阻塞读 stdin 会触发超时。 */
function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: ${ms}ms 内未完成 —— 内核在等 stdin`)), ms)
  })
  if (timer.unref) timer.unref()
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

test("headless 契约：未注入 handler 的 kernel 遇到需审批工具 → 确定性 deny 事件", async () => {
  registerWriteThenReply()
  const kernel = await createKernel({
    cwd: workDir,
    config: headlessConfig(),
    trustState: { trusted: true },
    boot: false
    // 刻意不注入 handlers.onPermissionPrompt —— headless 宿主的缺省形态
  })
  try {
    const seen = []
    const unsubscribe = kernel.events.subscribe((event) => {
      if (["permission.asked", "permission.decided"].includes(event.type)) seen.push(event)
    })

    const sessionId = "ses_headless_deny"
    const result = await withTimeout(kernel.executeTurn({
      prompt: "write a file",
      mode: "agent",
      model: "mock-model",
      providerType: PROVIDER,
      sessionId
    }), 15000, "executeTurn")

    unsubscribe()

    const asked = seen.filter((event) => event.type === "permission.asked")
    const decided = seen.filter((event) => event.type === "permission.decided")
    assert.equal(asked.length, 1, "审批应当被挂起为 permission.asked 事件")
    assert.equal(asked[0].payload.tool, "write")
    assert.equal(asked[0].sessionId, sessionId)
    assert.deepEqual(
      decided.map((event) => [event.payload.tool, event.payload.decision]),
      [["write", "deny"]],
      "无 handler 的 headless 宿主必须收到确定性 deny 事件，而不是阻塞在 stdin 上"
    )

    // 回合正常走完：工具被拒 → 模型收到拒绝结果 → 第二轮给出最终答复
    assert.equal(result.reply, "明白了，不动文件。")
    assert.equal(result.toolEvents.length, 1)
    assert.equal(result.toolEvents[0].status, "error")
    assert.match(result.toolEvents[0].output, /permission denied/)
    assert.match(result.toolEvents[0].output, /non_tty_default/)

    // 被拒的工具绝不能落盘
    await assert.rejects(readFile(join(workDir, "should-not-exist.txt"), "utf8"), /ENOENT/)
  } finally {
    await kernel.shutdown()
  }
})

test("headless 契约对照组：注入 handler 的宿主照常问答并放行", async () => {
  registerWriteThenReply()
  const asked = []
  const kernel = await createKernel({
    cwd: workDir,
    config: headlessConfig(),
    trustState: { trusted: true },
    boot: false,
    handlers: {
      onPermissionPrompt: (request) => {
        asked.push(request)
        return "allow_once"
      }
    }
  })
  try {
    const result = await withTimeout(kernel.executeTurn({
      prompt: "write a file",
      mode: "agent",
      model: "mock-model",
      providerType: PROVIDER,
      sessionId: "ses_headless_allow"
    }), 15000, "executeTurn")

    assert.equal(asked.length, 1, "宿主 handler 应收到恰好一次审批请求")
    assert.equal(asked[0].tool, "write")
    assert.equal(result.toolEvents[0].status, "completed", "handler 放行后工具应真的执行")
    // 工具真的落了盘（证明审批通道完整工作，而不是被一律 deny）
    assert.equal(await readFile(join(workDir, "should-not-exist.txt"), "utf8"), "no")
  } finally {
    await kernel.shutdown()
  }
})

test("审批通道：无 handler 时确定性收口，绝不读 stdin", async () => {
  assert.equal(defaultPermissionPromptChannel.canAskInteractively(), false,
    "没有宿主 handler 就是问不到人 —— 内核不再以 TTY 自居提问途径")
  const reply = await withTimeout(
    defaultPermissionPromptChannel.askPermissionInteractive({ tool: "write", sessionId: "ses_unit" }),
    5000,
    "askPermissionInteractive"
  )
  assert.equal(reply, "deny")
  const allowed = await defaultPermissionPromptChannel.askPermissionInteractive({
    tool: "write", sessionId: "ses_unit", defaultAction: "allow"
  })
  assert.equal(allowed, "allow_once", "permission.non_tty_default=allow 的显式配置仍受尊重")
})

test("提问通道：无 handler 时空答案 / plan_saved 确定性收口", async () => {
  assert.equal(defaultQuestionPromptChannel.hasPromptHandler(), false)
  const answers = await withTimeout(
    defaultQuestionPromptChannel.askQuestionInteractive({
      questions: [{ id: "q1", text: "问题", options: [] }]
    }),
    5000,
    "askQuestionInteractive"
  )
  assert.deepEqual(answers, { q1: "" }, "无 handler 的提问确定性返回空答案（空答案绝不当成用户选择）")

  const approval = await withTimeout(
    defaultQuestionPromptChannel.askPlanApproval({ plan: "计划", planPath: "/tmp/plan.md" }),
    5000,
    "askPlanApproval"
  )
  assert.equal(approval.action, "plan_saved", "headless 下的计划审批收口为 plan_saved，不再触发计划重写死循环")
  assert.equal(approval.approved, true)
  assert.equal(approval.planPath, "/tmp/plan.md")
})

test("工作区信任探测：无 prompt 注入时确定性 untrusted，注入后由前端回答", async () => {
  const untrustedDir = await mkdtemp(join(tmpdir(), "kkcode-trust-probe-"))
  try {
    // 即使声称是 TTY，没有 prompt 注入也不能问 —— 确定性 untrusted
    const withoutPrompt = await withTimeout(
      checkWorkspaceTrust({ cwd: untrustedDir, isTTY: true }),
      5000,
      "checkWorkspaceTrust without prompt"
    )
    assert.equal(withoutPrompt.trusted, false)

    const denied = await checkWorkspaceTrust({
      cwd: untrustedDir, isTTY: true, prompt: async () => "n"
    })
    assert.equal(denied.trusted, false)

    const granted = await checkWorkspaceTrust({
      cwd: untrustedDir, isTTY: true, prompt: async () => "yes"
    })
    assert.equal(granted.trusted, true, "前端注入的 prompt 回答 yes 即授信")
    // 授信已持久化：再次探测不再提问
    const persisted = await checkWorkspaceTrust({ cwd: untrustedDir, isTTY: false })
    assert.equal(persisted.trusted, true)
  } finally {
    await rm(untrustedDir, { recursive: true, force: true })
  }
})
