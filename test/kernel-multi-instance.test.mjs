// 1.0.0 阶段 2 完成判据 2（§6）：两个 createKernel() 实例的 PermissionEngine
// 信任态与 ToolRegistry 工具集互不可见 —— 证明 9 组模块级单例收编为实例字段
// 有效（M3 §四.2 的「半迁移状态分裂」地雷排除）。
import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createKernel } from "../src/kernel/index.mjs"

let homeDir
let workDirA
let workDirB

before(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "kkcode-kernel-multi-home-"))
  workDirA = await mkdtemp(join(tmpdir(), "kkcode-kernel-multi-a-"))
  workDirB = await mkdtemp(join(tmpdir(), "kkcode-kernel-multi-b-"))
  process.env.KKCODE_HOME = homeDir
})

after(async () => {
  delete process.env.KKCODE_HOME
  await rm(homeDir, { recursive: true, force: true })
  await rm(workDirA, { recursive: true, force: true })
  await rm(workDirB, { recursive: true, force: true })
})

function configWith({ builtinTools }) {
  return {
    config: {
      provider: { default: "openai" },
      agent: { default_mode: "agent", max_steps: 3 },
      permission: { level: "yolo", rules: [] },
      session: { max_history: 10 },
      tool: { sources: { builtin: builtinTools, local: false, plugin: false, mcp: false } },
      usage: { aggregation: ["turn"], budget: {} },
      ui: { markdown_render: false }
    }
  }
}

test("two createKernel() instances have isolated trust state and tool sets", async () => {
  const approvalsAsked = []
  const kernelA = await createKernel({
    cwd: workDirA,
    config: configWith({ builtinTools: true }),
    trustState: { trusted: true },
    handlers: {
      onPermissionPrompt: async ({ tool, pattern }) => {
        approvalsAsked.push(`${tool}:${pattern}`)
        return "allow_session"
      }
    }
  })
  const kernelB = await createKernel({
    cwd: workDirB,
    config: configWith({ builtinTools: false }),
    trustState: { trusted: false }
  })

  try {
    // --- 信任态隔离 ---
    assert.equal(kernelA.permissions.isTrusted(), true)
    assert.equal(kernelB.permissions.isTrusted(), false)

    // --- 会话级授权隔离：A 的 allow_session 不进 B 的会话表 ---
    // .git 是保护路径，任何档位都必走 ask（与具体档位无关的确定性 ask）。
    const granted = await kernelA.permissions.check({
      config: kernelA.configState.config,
      sessionId: "ses_multi",
      tool: "write",
      mode: "agent",
      pattern: ".git/config",
      workspace: workDirA
    })
    assert.equal(granted.decision, "allow_session")
    assert.deepEqual(approvalsAsked, ["write:.git/config"])
    assert.deepEqual(kernelA.permissions.listSession("ses_multi"), ["write::.git/config"])
    assert.deepEqual(kernelB.permissions.listSession("ses_multi"), [])

    // B 未信任工作区：check 直接收口为 PermissionError，而不是看到 A 的授权
    await assert.rejects(
      kernelB.permissions.check({
        config: kernelB.configState.config,
        sessionId: "ses_multi",
        tool: "write",
        mode: "agent",
        pattern: ".git/config",
        workspace: workDirB
      }),
      /workspace not trusted/
    )

    // --- 工具集隔离 ---
    const toolsA = await kernelA.tools.list({ mode: "agent" })
    const toolsB = await kernelB.tools.list({ mode: "agent" })
    assert.ok(toolsA.length > 0, "kernel A should expose builtin tools")
    assert.equal(toolsB.length, 0, "kernel B booted with builtin sources off")
    assert.ok(await kernelA.tools.get("read"))
    assert.equal(await kernelB.tools.get("read"), null)

    // --- 事件总线隔离：各自的 listeners 互不可见 ---
    const unsubA = kernelA.events.subscribe(() => {})
    assert.equal(kernelA.events.listenerCount(), 1)
    assert.equal(kernelB.events.listenerCount(), 0)
    unsubA()

    // --- 扩展/注册表实例互不相同 ---
    assert.notEqual(kernelA.extensions.skills, kernelB.extensions.skills)
    assert.notEqual(kernelA.extensions.hooks, kernelB.extensions.hooks)
    assert.notEqual(kernelA.providers, kernelB.providers)
  } finally {
    await kernelA.shutdown()
    await kernelB.shutdown()
  }
})
