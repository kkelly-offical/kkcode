import test from "node:test"
import assert from "node:assert/strict"
import { PassThrough } from "node:stream"
import { createTtyPromptHandlers } from "../src/cli/tty-prompts.mjs"

/**
 * TTY 前端审批/提问 handler（1.0.0 阶段 4，M12 遗留补位）。
 *
 * 3b 删除内核 fallback readline 后，交互式 chat 类入口（chat / session resume /
 * ultra start）的审批与提问能力由本模块经 createKernel({ handlers }) 注入恢复。
 * 这里钉住三件事：非 TTY 必须返回 null（维持确定性收口，绝不在 stdin 阻塞）、
 * 审批答案映射与 3b 前的内核 fallback 逐字一致、提问表单与 REPL 浮层同语义
 * （选项编号 / Custom 自由文本 / default 回车 / secret 遮蔽回显）。
 */

function makeStreams() {
  const input = new PassThrough()
  const output = new PassThrough()
  let written = ""
  output.on("data", (chunk) => { written += chunk.toString("utf8") })
  return { input, output, readWritten: () => written }
}

function makeHandlers() {
  const streams = makeStreams()
  const handlers = createTtyPromptHandlers({ input: streams.input, output: streams.output, isTTY: true })
  return { ...streams, handlers }
}

test("非 TTY 返回 null —— 调用方省略 handlers，内核保持 3b 的确定性收口", () => {
  const input = new PassThrough()
  const output = new PassThrough()
  assert.equal(createTtyPromptHandlers({ input, output }), null)
})

test("审批答案映射与 3b 前内核 fallback 一致：1/2/3 → allow_once/session/always", async () => {
  for (const [answer, expected] of [["1", "allow_once"], ["2", "allow_session"], ["3", "allow_always"]]) {
    const { input, handlers } = makeHandlers()
    const pending = handlers.onPermissionPrompt({ tool: "bash", sessionId: "ses_t", command: "ls" })
    input.write(`${answer}\n`)
    assert.equal(await pending, expected)
  }
})

test("审批的无法识别输入与直接回车一律 deny —— 猜错方向的代价不对称", async () => {
  for (const answer of ["4", "no", "", "随便写"]) {
    const { input, handlers } = makeHandlers()
    const pending = handlers.onPermissionPrompt({ tool: "bash", sessionId: "ses_t", defaultAction: "allow" })
    input.write(`${answer}\n`)
    // 即使 defaultAction 是 allow，问得到人时用户的空输入也不能被当成允许
    assert.equal(await pending, "deny")
  }
})

test("审批提示把工具/命令/风险写出去，让用户知道在批什么", async () => {
  const { input, handlers, readWritten } = makeHandlers()
  const pending = handlers.onPermissionPrompt({
    tool: "bash", sessionId: "ses_t", command: "rm -rf build", risk: 7, reason: "清理产物"
  })
  input.write("1\n")
  assert.equal(await pending, "allow_once")
  const shown = readWritten()
  assert.match(shown, /Permission requested for tool: bash/)
  assert.match(shown, /command: rm -rf build/)
  assert.match(shown, /risk: 7\/10/)
  assert.match(shown, /reason: 清理产物/)
})

test("提问：选项编号取选项值，超出编号的文本按 Custom 原文返回", async () => {
  const { input, handlers } = makeHandlers()
  const pending = handlers.onQuestionPrompt({
    questions: [{
      id: "plan_approval",
      text: "Plan Next Step",
      options: [
        { label: "Build", value: "assistant" },
        { label: "Revise Plan", value: "revise" }
      ]
    }]
  })
  input.write("1\n")
  assert.deepEqual(await pending, { plan_approval: "assistant" })

  const custom = makeHandlers()
  const customPending = custom.handlers.onQuestionPrompt({
    questions: [{ id: "q", text: "t", options: [{ label: "A", value: "a" }] }]
  })
  custom.input.write("请改成三步走\n")
  assert.deepEqual(await customPending, { q: "请改成三步走" })
})

test("提问：无选项题直接回车采用 default；无 default 得到空串", async () => {
  const { input, handlers } = makeHandlers()
  const pending = handlers.onQuestionPrompt({
    questions: [
      { id: "with_default", text: "t1", default: "fallback-value" },
      { id: "without_default", text: "t2" }
    ]
  })
  // 逐行到达：同一 chunk 里塞两行会让第二个 line 事件在第二个 question 挂上
  // 之前发出（readline 经典坑）。真实 TTY 的按键天然逐行。
  input.write("\n")
  await new Promise((resolve) => setImmediate(resolve))
  input.write("\n")
  assert.deepEqual(await pending, { with_default: "fallback-value", without_default: "" })
})

test("提问：secret 题回显被遮蔽成 •，真值仍是输入原文", async () => {
  const { input, handlers, readWritten } = makeHandlers()
  const pending = handlers.onQuestionPrompt({
    questions: [{ id: "api_key", text: "key?", secret: true }]
  })
  input.write("sk-secret\n")
  assert.deepEqual(await pending, { api_key: "sk-secret" })
  const shown = readWritten()
  assert.ok(!shown.includes("sk-secret"), "密钥原文不得出现在回显里")
})
