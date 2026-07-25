import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * Ultra 结果的透传链：runHybridLongAgent → packLongAgent → result.longagent。
 *
 * 0.4.x 在 engine.mjs 的两个位置（预算阻断路径与正常路径）各手写了一份逐字段
 * 枚举的打包对象。两处都漏了 recoverySuggestions —— 而 generateRecoverySuggestions
 * 认认真真生成了失败任务分类、手动排查步骤和恢复提示，放进返回值之后被静默
 * 丢弃，全代码库零消费者。用户从来没见过这份诊断。
 *
 * currentStageId 是反过来的毛病：status-bar 和 repl 都在读它，而 hybrid 从来
 * 没返回过，所以它恒为 undefined。
 */

const tmpHome = await mkdtemp(path.join(os.tmpdir(), "kkcode-passthrough-home-"))
const tmpProject = await mkdtemp(path.join(os.tmpdir(), "kkcode-passthrough-proj-"))
process.env.KKCODE_HOME = tmpHome
const originalCwd = process.cwd()
process.chdir(tmpProject)

const { packLongAgent } = await import("../src/session/engine.mjs")
const { registerProvider } = await import("../src/provider/router.mjs")
const { runHybridLongAgent } = await import("../src/session/longagent-hybrid.mjs")

registerProvider("mock_passthrough", {
  async request() { return { text: "ok", toolCalls: [], usage: {} } },
  async *requestStream() { yield { type: "text", content: "ok" } }
})

test.after(async () => {
  process.chdir(originalCwd)
  await rm(tmpHome, { recursive: true, force: true }).catch(() => {})
  await rm(tmpProject, { recursive: true, force: true }).catch(() => {})
})

test("packLongAgent 透传 0.4.x 丢掉的三个字段", () => {
  const recovery = {
    summary: "状态: failed, 失败: 2 task(s)",
    suggestions: ["编码阶段未完成，可尝试缩小任务范围后重试"],
    failedTasks: [{ taskId: "t1", error: "ENOENT", category: "permanent" }],
    manualSteps: ["检查 build gate 的失败原因"],
    resumeHint: "已完成 3 个 task，可从 checkpoint 恢复继续"
  }
  const packed = packLongAgent({
    status: "failed", phase: "H6", stageIndex: 2, stageCount: 3,
    currentStageId: "stage_3", gitBranch: "kkcode/x", gitBaseBranch: "main",
    recoverySuggestions: recovery
  })

  assert.deepEqual(packed.recoverySuggestions, recovery, "失败诊断必须能到达用户")
  assert.equal(packed.currentStageId, "stage_3")
  assert.equal(packed.gitBranch, "kkcode/x")
  assert.equal(packed.gitBaseBranch, "main")
})

test("缺字段时给出稳定的空值而不是 undefined", () => {
  const packed = packLongAgent({ status: "done" })
  assert.equal(packed.recoverySuggestions, null)
  assert.equal(packed.currentStageId, null)
  assert.equal(packed.gitBranch, null)
  assert.deepEqual(packed.fileChanges, [])
  assert.deepEqual(packed.lastGateFailures, [])
})

test("真跑一轮后诊断确实能穿过打包层", async () => {
  const turn = await runHybridLongAgent({
    prompt: "实现 src/foo.mjs 并补上对应测试",
    model: "mock-model",
    providerType: "mock_passthrough",
    sessionId: "passthrough_run",
    configState: {
      config: {
        provider: {
          default: "mock_passthrough",
          mock_passthrough: { default_model: "mock-model", timeout_ms: 5000, stream: false }
        },
        agent: {
          max_steps: 1,
          longagent: {
            hybrid: {
              intake: false, project_memory: false, checkpoint_resume: false,
              task_bus: false, checkpoint_cleanup: false, completion_validation: false,
              cross_review: false
            },
            git: { enabled: false },
            scaffold: { enabled: false },
            usability_gates: {
              prompt_user: "never",
              build: { enabled: false }, test: { enabled: false }, review: { enabled: false },
              health: { enabled: false }, budget: { enabled: false }
            }
          }
        }
      }
    }
  })

  const packed = packLongAgent(turn)
  for (const key of ["status", "phase", "stageIndex", "stageCount", "taskProgress", "fileChanges"]) {
    assert.ok(key in packed, `打包结果缺少 ${key}`)
  }
  // 没跑到 completed 时 hybrid 一定会生成诊断；生成了就必须能穿过打包层
  if (turn.recoverySuggestions) {
    assert.ok(packed.recoverySuggestions, "hybrid 生成了诊断却在打包时被丢弃")
    assert.ok(packed.recoverySuggestions.summary)
  }
})
