import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { askBlockedDecision, confirmManualCriteria } from "../src/session/ultra-interaction.mjs"

/**
 * 受阻交互的非 TTY 收口。0.4.1 的 plan 死循环与门禁偏好事故是同一类根因：
 * 「没人回答」被解读成了某个具体的选择。这里锁死：空答案永远走收口，
 * 收口默认 deliver_partial，continue 必须显式配置。
 */

const noTTY = { isTTY: false, hasPromptHandler: () => false }
const withAnswers = (answers) => ({
  isTTY: true,
  hasPromptHandler: () => true,
  askQuestionInteractive: async () => answers
})

describe("askBlockedDecision 非 TTY 收口", () => {
  it("无 handler 且无 TTY → deliver_partial，绝不 continue", async () => {
    const d = await askBlockedDecision({ report: null, config: {}, deps: noTTY })
    assert.equal(d.action, "deliver_partial")
    assert.equal(d.source, "non_tty_default")
    assert.equal(d.why, "non_tty")
  })

  it("allowQuestion=false → 收口", async () => {
    const d = await askBlockedDecision({ allowQuestion: false, config: {}, deps: withAnswers({ ultra_blocked: "continue" }) })
    assert.equal(d.action, "deliver_partial")
    assert.equal(d.why, "allow_question_false")
  })

  it("空答案 ≠ 继续 —— 0.4.1 那类事故的同源防护", async () => {
    for (const empty of ["", "   ", "(skipped)"]) {
      const d = await askBlockedDecision({ config: {}, deps: withAnswers({ ultra_blocked: empty }) })
      assert.equal(d.action, "deliver_partial", `空答案 ${JSON.stringify(empty)} 被解读成了 ${d.action}`)
      assert.equal(d.source, "non_tty_default")
    }
  })

  it("收口动作可配置，continue 需要显式选择", async () => {
    const config = { agent: { longagent: { ultra: { on_blocked_non_tty: "continue" } } } }
    const d = await askBlockedDecision({ config, deps: noTTY })
    assert.equal(d.action, "continue", "显式配置后才允许无人值守续跑")

    const bogus = { agent: { longagent: { ultra: { on_blocked_non_tty: "party" } } } }
    assert.equal((await askBlockedDecision({ config: bogus, deps: noTTY })).action, "deliver_partial", "非法配置退回安全默认")
  })
})

describe("askBlockedDecision 用户选择", () => {
  it("四个标准选项", async () => {
    assert.equal((await askBlockedDecision({ deps: withAnswers({ ultra_blocked: "continue" }) })).action, "continue")
    assert.equal((await askBlockedDecision({ deps: withAnswers({ ultra_blocked: "停止" }) })).action, "stop")
    assert.equal((await askBlockedDecision({ deps: withAnswers({ ultra_blocked: "deliver_partial" }) })).action, "deliver_partial")
  })

  it("自定义文本一律当指引", async () => {
    const d = await askBlockedDecision({ deps: withAnswers({ ultra_blocked: "别用 sqlite 了，直接写 JSON 文件" }) })
    assert.equal(d.action, "guidance")
    assert.equal(d.text, "别用 sqlite 了，直接写 JSON 文件")
    assert.equal(d.source, "user")
  })

  it("选了「给指引」但没给内容 → 收口而不是空指引续跑", async () => {
    let call = 0
    const deps = {
      isTTY: true, hasPromptHandler: () => true,
      askQuestionInteractive: async () => (++call === 1 ? { ultra_blocked: "guidance" } : { ultra_guidance: "" })
    }
    const d = await askBlockedDecision({ config: {}, deps })
    assert.equal(d.action, "deliver_partial")
    assert.equal(d.why, "empty_guidance")
  })
})

describe("confirmManualCriteria", () => {
  const pending = [
    { id: "m1", text: "UI 上能看到进度", question: "UI 上能看到进度吗？" },
    { id: "m2", text: "文案符合语气", question: "文案符合语气吗？" }
  ]

  it("非 TTY → 空集，manual 保持 pending，绝不代替用户点头", async () => {
    const confirmed = await confirmManualCriteria({ pending, deps: noTTY })
    assert.equal(confirmed.size, 0)
  })

  it("逐条确认，只有明确 yes 才算", async () => {
    const confirmed = await confirmManualCriteria({
      pending,
      deps: withAnswers({ m1: "yes", m2: "no" })
    })
    assert.deepEqual([...confirmed], ["m1"])
  })

  it("空清单不发问", async () => {
    let asked = false
    const confirmed = await confirmManualCriteria({
      pending: [],
      deps: { isTTY: true, hasPromptHandler: () => true, askQuestionInteractive: async () => { asked = true; return {} } }
    })
    assert.equal(confirmed.size, 0)
    assert.equal(asked, false)
  })
})
