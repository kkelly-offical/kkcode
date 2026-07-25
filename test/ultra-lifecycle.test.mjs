import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * Ultra 的生命周期收尾。
 *
 * 0.4.x 的 runHybridLongAgent 在启动时向 EventBus 订阅 stop 事件，但退订散落
 * 在三条返回路径上，而 blueprint 审查被拒的那条**漏了**；异常（Ctrl+C 抛出的
 * "provider stream cancelled"、provider 故障、runStageBarrier 对依赖环与文件
 * 所有权冲突的 throw）则会跳过全部收尾 —— 监听器泄漏，会话永久停在
 * running-longagent。
 *
 * 这两件事都没有别的观察手段，所以 EventBus 补了 listenerCount()。
 */

const tmpHome = await mkdtemp(path.join(os.tmpdir(), "kkcode-ultra-home-"))
const tmpProject = await mkdtemp(path.join(os.tmpdir(), "kkcode-ultra-proj-"))
process.env.KKCODE_HOME = tmpHome
const originalCwd = process.cwd()
process.chdir(tmpProject)

const { EventBus } = await import("../src/core/events.mjs")
const { LongAgentManager } = await import("../src/orchestration/longagent-manager.mjs")
const { registerProvider } = await import("../src/provider/router.mjs")
const { runHybridLongAgent } = await import("../src/session/longagent-hybrid.mjs")

test.after(async () => {
  process.chdir(originalCwd)
  await rm(tmpHome, { recursive: true, force: true }).catch(() => {})
  await rm(tmpProject, { recursive: true, force: true }).catch(() => {})
})

// 一个只会炸的 provider。注意：provider 故障**不会**穿透出 runHybridLongAgent
// —— processTurnLoop 会重试后把它变成一句 `provider error: ...` 的正常回复，
// 流水线照跑到 H6 并返回 status "done"。（这条「全程失败仍报 done」的问题属于
// 终止状态判定，见 0.5.0 计划第十节，不在本次收尾的范围内。）
// 所以要触发真正的异常穿透，得从状态落盘这一层注入。
registerProvider("mock_quiet", {
  async request() { return { text: "ok", toolCalls: [], usage: {} } },
  async *requestStream() { yield { type: "text", content: "ok" } }
})

/** 让第一次 LongAgentManager.update（syncState 那次）抛出指定错误。 */
async function withFirstUpdateThrowing(error, fn) {
  const original = LongAgentManager.update
  let calls = 0
  LongAgentManager.update = async (...args) => {
    calls += 1
    if (calls === 1) throw error
    return original(...args)
  }
  try {
    return await fn()
  } finally {
    LongAgentManager.update = original
  }
}

function configState(providerName = "openai") {
  return {
    config: {
      provider: {
        default: providerName,
        [providerName]: { default_model: "mock-model", timeout_ms: 5000, stream: false }
      },
      agent: {
        max_steps: 1,
        longagent: {
          hybrid: {
            intake: false,
            project_memory: false,
            checkpoint_resume: false,
            task_bus: false,
            checkpoint_cleanup: false
          },
          git: { enabled: false },
          scaffold: { enabled: false },
          usability_gates: { prompt_user: "never" }
        }
      }
    }
  }
}

test("早退路径不泄漏 stop 监听器", async () => {
  const before = EventBus.listenerCount()

  for (let i = 0; i < 3; i++) {
    const result = await runHybridLongAgent({
      prompt: "你好",                       // 不是可执行目标，H0 之前就返回
      model: "m", providerType: "openai",
      sessionId: `lifecycle_blocked_${i}`,
      configState: configState()
    })
    assert.equal(result.status, "needs_objective")
  }

  assert.equal(EventBus.listenerCount(), before,
    "每条返回路径都必须退订，否则每跑一次 Ultra 就泄漏一个监听器")
})

test("异常穿透时仍然退订，且会话不会卡在 running", async () => {
  const before = EventBus.listenerCount()
  const sessionId = "lifecycle_throw"

  await withFirstUpdateThrowing(new Error("state store exploded"), () =>
    assert.rejects(
      runHybridLongAgent({
        prompt: "实现一个新的 src/foo.mjs 模块并补上测试",
        model: "mock-model", providerType: "mock_quiet",
        sessionId, configState: configState("mock_quiet")
      }),
      /state store exploded/
    )
  )

  assert.equal(EventBus.listenerCount(), before, "异常路径也必须退订")

  const record = await LongAgentManager.get(sessionId)
  assert.ok(record, "异常后仍应留下会话记录")
  assert.notEqual(record.status, "running",
    "0.4.x 在这里会把会话永久留在 running —— 恢复逻辑会以为它还活着")
  assert.equal(record.status, "fatal")
  assert.match(record.lastMessage || "", /内部错误/)
})

test("用户中断被记为 aborted 而不是失败", async () => {
  const before = EventBus.listenerCount()
  const sessionId = "lifecycle_abort"
  const abortError = new Error("provider stream cancelled")
  abortError.code = "ABORT_ERR"
  abortError.errorClass = "aborted"

  await withFirstUpdateThrowing(abortError, () =>
    assert.rejects(runHybridLongAgent({
      prompt: "实现一个新的 src/foo.mjs 模块并补上测试",
      model: "mock-model", providerType: "mock_quiet",
      sessionId, configState: configState("mock_quiet")
    }))
  )

  assert.equal(EventBus.listenerCount(), before)
  const record = await LongAgentManager.get(sessionId)
  assert.equal(record.status, "aborted", "中断是用户意图，不该被记成故障")
})
