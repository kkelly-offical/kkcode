import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runBtwQuery, trimForBtw, BTW_SYSTEM_PROMPT } from "../src/repl/btw-query.mjs"
import {
  configureSessionStore,
  touchSession,
  appendUserMessage,
  appendAssistantMessage,
  getSession
} from "../src/session/store.mjs"

/**
 * `/btw` 的回归网。
 *
 * 这个模块的价值全在四条约束上（看得见历史 / 不改历史 / 禁工具 / 不带主 system），
 * 而这四条**都是「没发生什么」型的性质** —— 实现写错时功能照样能用：答案照出，
 * 只是历史被悄悄写脏了、或者把 10KB 的 tool_result 又发了一遍。所以这里的断言
 * 大多在查发出去的请求里**没有**什么，最后一条更是直接拿真实会话存储来查。
 */

let tmpDir

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kkcode-btw-test-"))
  process.env.KKCODE_HOME = tmpDir
  // 同步落盘：省掉 1s 的 flush 定时器，也就不会有悬着的 handle 拖住测试进程
  configureSessionStore({ flushIntervalMs: 0 })
})

after(async () => {
  delete process.env.KKCODE_HOME
  await rm(tmpDir, { recursive: true, force: true })
})

/** 假的 provider：记下收到的入参，回一句固定答案。 */
function recorder(responseText = "42") {
  const calls = []
  return {
    calls,
    request: async (input) => {
      calls.push(input)
      return { text: responseText }
    }
  }
}

const historyOf = (...pairs) => pairs.map(([role, content]) => ({ role, content }))

/** 发出去的东西整体序列化 —— 用来查「某段内容一个字都没漏出去」。 */
const wireOf = (call) => JSON.stringify(call.messages)

async function ask(question, { history = [], request, ...rest } = {}) {
  return runBtwQuery({
    question,
    sessionId: "s1",
    state: { model: "m", providerType: "p" },
    configState: { config: {} },
    loadMessages: async () => history,
    request,
    ...rest
  })
}

// --- 看得见历史 ---

test("带上最近的历史，顺序不变，问题在最后", async () => {
  const { calls, request } = recorder()
  const result = await ask("这个 flag 是干嘛的", {
    history: historyOf(["user", "先看看 router"], ["assistant", "看完了"], ["user", "改一下超时"]),
    request
  })

  assert.deepEqual(result, { ok: true, answer: "42" })
  assert.deepEqual(calls[0].messages, [
    { role: "user", content: "先看看 router" },
    { role: "assistant", content: "看完了" },
    { role: "user", content: "改一下超时" },
    { role: "user", content: "这个 flag 是干嘛的" }
  ])
})

test("超出上限时裁掉的是旧的那头", async () => {
  const { calls, request } = recorder()
  await ask("刚才说到哪了", {
    history: historyOf(
      ["user", "第一句"], ["assistant", "第二句"],
      ["user", "第三句"], ["assistant", "第四句"], ["user", "第五句"]
    ),
    request,
    maxContextMessages: 3
  })

  assert.deepEqual(calls[0].messages.map((m) => m.content), ["第三句", "第四句", "第五句", "刚才说到哪了"])
  assert.doesNotMatch(wireOf(calls[0]), /第一句|第二句/, "裁掉的应该是旧的，不是新的")
})

test("会话为空也能问 —— 刚开局就 /btw 不该报错", async () => {
  const { calls, request } = recorder("空手也能答")
  const result = await ask("kkcode 是什么", { history: [], request })

  assert.deepEqual(result, { ok: true, answer: "空手也能答" })
  assert.deepEqual(calls[0].messages, [{ role: "user", content: "kkcode 是什么" }])
})

test("历史读不出来仍然能问，只是没有上下文", async () => {
  const { calls, request } = recorder()
  const result = await runBtwQuery({
    question: "随便问问",
    sessionId: "s1",
    state: {},
    loadMessages: async () => { throw new Error("session file corrupt") },
    request
  })

  assert.equal(result.ok, true)
  assert.deepEqual(calls[0].messages, [{ role: "user", content: "随便问问" }])
})

// --- 大块载荷剥离 ---

test("10KB 的 tool_result 一个字都不发出去", async () => {
  const payload = "X".repeat(10 * 1024)
  const { calls, request } = recorder()
  await ask("刚才那步干了什么", {
    history: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "a.mjs" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: payload }] }
    ],
    request
  })

  const wire = wireOf(calls[0])
  assert.equal(wire.includes(payload), false, "整块 tool_result 被原样发了出去")
  assert.doesNotMatch(wire, /XXXXXXXXXX/, "tool_result 的内容片段仍然漏在请求里")
  assert.match(wire, /\[tool result omitted\]/, "剥掉了但没留下发生过工具调用的痕迹")
  assert.ok(wire.length < 2000, `请求体 ${wire.length} 字节，10KB 载荷显然还在里面`)
})

test("图片 base64 被剥掉", async () => {
  const base64 = "iVBORw0KGgo" + "A".repeat(4096)
  const { calls, request } = recorder()
  await ask("那张图上是什么", {
    history: [
      { role: "user", content: [
        { type: "text", text: "看看这个" },
        { type: "image", mediaType: "image/png", data: base64 }
      ] },
      // Anthropic 原生形状：载荷藏在 source.data 里
      { role: "assistant", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: base64 } }] }
    ],
    request
  })

  const wire = wireOf(calls[0])
  assert.equal(wire.includes(base64), false, "图片 base64 被发了出去")
  assert.doesNotMatch(wire, /AAAAAAAAAA/, "base64 片段仍然漏在请求里")
  assert.match(wire, /看看这个/, "同一条消息里的文本不该被连坐删掉")
})

test("思考块不转发 —— 各家的签名校验规则不一样，带上只会 400", async () => {
  const { calls, request } = recorder()
  await ask("继续", {
    history: [
      { role: "assistant", content: [
        { type: "reasoning", text: "内心戏：也许应该先读文件" },
        { type: "text", text: "我先读一下文件" }
      ] }
    ],
    request
  })

  assert.doesNotMatch(wireOf(calls[0]), /内心戏/)
  assert.match(wireOf(calls[0]), /我先读一下文件/)
})

// --- 禁工具 ---

test("请求里不带任何工具", async () => {
  const { calls, request } = recorder()
  await ask("顺便问一下", {
    history: historyOf(["user", "帮我改文件"]),
    request
  })

  assert.deepEqual(calls[0].tools, [], `tools 应当是空数组，实际是 ${JSON.stringify(calls[0].tools)}`)
})

test("历史里的 tool_use / tool_result 块不会原样转发", async () => {
  // 不只是省 token：tools 为空时，messages 里出现这两种块 Anthropic 直接 400。
  // 「带上历史」和「禁工具」在原样转发时是互斥的。
  const { calls, request } = recorder()
  await ask("刚才为什么读那个文件", {
    history: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "src/repl.mjs" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] }
    ],
    request
  })

  const wire = wireOf(calls[0])
  assert.doesNotMatch(wire, /"type"\s*:\s*"tool_use"/, "tool_use 块被原样转发，禁工具后这会让上游 400")
  assert.doesNotMatch(wire, /"type"\s*:\s*"tool_result"/, "tool_result 块被原样转发")
  assert.doesNotMatch(wire, /tool_use_id/)
  assert.match(wire, /\[tool call: read\]/, "调过哪个工具这条线索该留着")
})

// --- system prompt ---

test("system 是旁路专用短句，不带主会话的 agent prompt", async () => {
  const { calls, request } = recorder()
  await ask("顺便问一下", { history: historyOf(["user", "干活"]), request })

  assert.equal(calls[0].system, BTW_SYSTEM_PROMPT)
  assert.match(calls[0].system, /side question/)
  assert.match(calls[0].system, /Do not use tools/)
  assert.doesNotMatch(calls[0].system, /You are kkcode|coding agent|<system-reminder>/i,
    "主会话 system prompt 混进来了")
  assert.ok(calls[0].system.length < 300, `旁路 system 有 ${calls[0].system.length} 字符，太长说明混进了别的东西`)
})

// --- 失败路径都不抛 ---

test("上游报错 → ok:false，错误是句人话", async () => {
  const result = await ask("问一句", {
    request: async () => { throw new Error("没有配置任何 provider。运行 kkcode 后输入 /provider add 添加一个。") }
  })

  assert.equal(result.ok, false)
  assert.equal("answer" in result, false)
  assert.match(result.error, /provider add/, "上游写好的下一步指引应当原样透出")
  assert.doesNotMatch(result.error, /at .*\.mjs:\d+|\[object Object\]|undefined/, "错误里漏出了栈或内部值")
})

test("取消掉的请求说「已取消」，不说网络错", async () => {
  const controller = new AbortController()
  const result = await ask("问一句", {
    signal: controller.signal,
    request: async () => {
      controller.abort()
      throw new Error("socket hang up")
    }
  })

  assert.deepEqual(result, { ok: false, error: "已取消" })
})

test("模型回了空正文 → ok:false 而不是一个空浮层", async () => {
  const result = await ask("问一句", { request: async () => ({ text: "   " }) })
  assert.equal(result.ok, false)
  assert.match(result.error, /没有返回内容/)
})

test("问题为空就不发请求", async () => {
  const { calls, request } = recorder()
  for (const empty of ["", "   ", null, undefined]) {
    const result = await ask(empty, { request })
    assert.equal(result.ok, false, `${JSON.stringify(empty)} 不该被当成一个问题`)
    assert.match(result.error, /\/btw/, "空输入该告诉用户用法")
  }
  assert.deepEqual(calls, [], "空问题不该发出任何请求")
})

// --- trimForBtw 的边界 ---

test("trimForBtw：首条是 assistant 时补一条 user，而不是把它丢掉", () => {
  // 上游要求首条是 user；而按尾部切片切出来的第一条经常是 assistant，
  // 那句往往正是用户「顺便问一下」所指的内容 —— 丢了问题就没法回答了。
  const trimmed = trimForBtw(historyOf(["assistant", "答"], ["user", "问"]), 40)
  assert.equal(trimmed[0].role, "user")
  assert.deepEqual(trimmed.slice(1), [
    { role: "assistant", content: "答" },
    { role: "user", content: "问" }
  ])
})

test("trimForBtw：max 为 0 或负数返回空，不是「全都带上」", () => {
  // slice(-0) 返回整个数组。这条钉子就是钉这个。
  const history = historyOf(["user", "一"], ["user", "二"])
  assert.deepEqual(trimForBtw(history, 0), [])
  assert.deepEqual(trimForBtw(history, -5), [])
  assert.deepEqual(trimForBtw(history, Number.NaN), [])
})

test("trimForBtw：非数组、空块消息、非对话角色都被挡掉", () => {
  assert.deepEqual(trimForBtw(null, 40), [])
  assert.deepEqual(trimForBtw(undefined, 40), [])
  assert.deepEqual(
    trimForBtw([
      { role: "user", content: "问" },
      { role: "system", content: "系统提示" },
      { role: "assistant", content: [{ type: "reasoning", text: "只有思考" }] }
    ], 40),
    [{ role: "user", content: "问" }],
    "只剩思考块的消息压完是空的，空 content 会被 provider 拒收"
  )
})

// --- 不改历史：拿真实存储验，不看源码 ---

test("跑完一次 /btw，真实会话存储一个字节都没变", async () => {
  const sessionId = "btw-readonly-session"
  await touchSession({ sessionId, mode: "build", model: "m", providerType: "p", cwd: "/tmp" })
  await appendUserMessage(sessionId, "帮我改 router 的超时")
  await appendAssistantMessage(sessionId, "改好了")

  const before = await getSession(sessionId)

  // 注意：这里**不注入** loadMessages，走真实的 getConversationHistory ——
  // 顺带验默认读取接线没接错。
  const { calls, request } = recorder("旁路答案")
  const result = await runBtwQuery({
    question: "顺便问一下，超时的单位是什么",
    sessionId,
    state: { model: "m", providerType: "p" },
    configState: { config: {} },
    request
  })

  assert.equal(result.ok, true)
  assert.deepEqual(calls[0].messages.map((m) => m.content), [
    "帮我改 router 的超时",
    "改好了",
    "顺便问一下，超时的单位是什么"
  ], "默认读取应当接在 getConversationHistory 上")

  const after = await getSession(sessionId)
  assert.equal(after.messages.length, 2, "问答被写进会话了 —— /btw 的全部意义就是不写")
  assert.deepEqual(after.messages, before.messages)
  assert.deepEqual(after.parts, before.parts)
  assert.doesNotMatch(JSON.stringify(after), /顺便问一下|旁路答案/, "问题或答案渗进了会话存储")
})
