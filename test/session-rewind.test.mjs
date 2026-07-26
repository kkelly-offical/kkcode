import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import { rewindLastTurn, countRewindableTurns } from "../src/session/rewind.mjs"

/**
 * 0.6.2：上下文回溯（连按两下 Esc）。
 *
 * 说错了、模型跑偏了、或只是想换个问法，应该能退回去重来，而不是被迫在
 * 一段已经歪掉的上下文里继续往前顶。
 *
 * 边界有两条：一轮 = 从一条用户消息到下一条之前的全部内容（包含中间的
 * 工具调用）；压缩摘要虽然以 user 消息的形态存在，但不是用户说的话 ——
 * 把它当成轮次起点会让一次回溯丢掉整段被压缩的历史。
 */

function fakeStore(messages) {
  const state = { messages: [...messages] }
  return {
    state,
    deps: {
      getConversationHistory: async () => [...state.messages],
      replaceMessages: async (_id, next) => { state.messages = [...next] }
    }
  }
}

const TURN_1 = [
  { role: "user", content: "第一个问题" },
  { role: "assistant", content: "第一个回答" }
]
const TURN_2 = [
  { role: "user", content: "第二个问题" },
  { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read" }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] },
  { role: "assistant", content: "第二个回答" }
]

describe("回溯一轮", () => {
  it("撤回最近一轮，保留之前的历史", async () => {
    const { state, deps } = fakeStore([...TURN_1, ...TURN_2])
    const result = await rewindLastTurn("s1", { deps })

    assert.equal(result.ok, true)
    assert.equal(state.messages.length, 2, "应当只剩第一轮")
    assert.equal(state.messages[0].content, "第一个问题")
  })

  it("把撤回的那句输入交还给调用方 —— 退回去改一下再问应该是一步", async () => {
    const { deps } = fakeStore([...TURN_1, ...TURN_2])
    const result = await rewindLastTurn("s1", { deps })
    assert.equal(result.prompt, "第二个问题")
  })

  it("一轮包含中间的工具往返，不会只退一半", async () => {
    const { state, deps } = fakeStore([...TURN_1, ...TURN_2])
    const result = await rewindLastTurn("s1", { deps })
    assert.equal(result.removed, TURN_2.length)
    assert.ok(!state.messages.some((m) => Array.isArray(m.content) && m.content[0]?.type === "tool_use"))
  })

  it("连续回溯可以一路退到开头", async () => {
    const { state, deps } = fakeStore([...TURN_1, ...TURN_2])
    await rewindLastTurn("s1", { deps })
    await rewindLastTurn("s1", { deps })
    assert.equal(state.messages.length, 0)
  })
})

describe("压缩摘要不算一轮", () => {
  const SUMMARY = { role: "user", content: '<compaction-summary version="2">前情提要</compaction-summary>' }

  it("回溯不会把压缩摘要当成轮次起点", async () => {
    const { state, deps } = fakeStore([SUMMARY, ...TURN_2])
    const result = await rewindLastTurn("s1", { deps })

    assert.equal(result.ok, true)
    assert.equal(result.prompt, "第二个问题", "起点应当是真实的用户输入")
    assert.equal(state.messages.length, 1, "摘要必须留下")
    assert.match(state.messages[0].content, /compaction-summary/)
  })

  it("只剩摘要时报告无可回溯，而不是把它删掉", async () => {
    const { state, deps } = fakeStore([SUMMARY])
    const result = await rewindLastTurn("s1", { deps })
    assert.equal(result.ok, false)
    assert.equal(result.reason, "nothing_to_rewind")
    assert.equal(state.messages.length, 1)
  })
})

describe("没得可退时诚实报告", () => {
  it("空会话", async () => {
    const { deps } = fakeStore([])
    const result = await rewindLastTurn("s1", { deps })
    assert.equal(result.ok, false)
    assert.equal(result.reason, "empty_session")
    assert.equal(result.removed, 0)
  })
})

test("统计可回溯轮次（用于给出诚实提示而不是静默无反应）", async () => {
  const { deps } = fakeStore([
    { role: "user", content: '<compaction-summary version="2">x</compaction-summary>' },
    ...TURN_1,
    ...TURN_2
  ])
  // TURN_2 里的 tool_result 也是 user 角色，同样计入 —— 这里只要求它不把
  // 摘要算进去；精确的轮次划分由 rewindLastTurn 负责。
  const count = await countRewindableTurns("s1", { deps })
  assert.ok(count >= 2, `至少两轮真实输入: ${count}`)
})
