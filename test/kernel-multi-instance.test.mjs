// 1.0.0 阶段 2 完成判据 2（§6）：两个 createKernel() 实例的 PermissionEngine
// 信任态与 ToolRegistry 工具集互不可见 —— 证明 9 组模块级单例收编为实例字段
// 有效（M3 §四.2 的「半迁移状态分裂」地雷排除）。
import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, access } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createKernel } from "../src/kernel/index.mjs"
// 桥生命周期回归（review round 1：P1 非 LIFO 恢复、P2-1 失败回滚、P2-2
// shutdown 重试）需要观察进程级默认值，故直接引用默认引擎/槽位/总线。
import { PermissionEngine } from "../src/kernel/permission/engine.mjs"
import { defaultPermissionPromptChannel } from "../src/kernel/permission/prompt.mjs"
import { defaultQuestionPromptChannel } from "../src/kernel/tool/question-prompt.mjs"
import { defaultEventBus } from "../src/kernel/core/events.mjs"
import { configureSessionStore } from "../src/kernel/session/store.mjs"
import { sessionDataPath } from "../src/storage/paths.mjs"

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

// --- review round 1 回归：2b 过渡桥生命周期（P1 / P2-1 / P2-2）---

function resetProcessDefaults() {
  PermissionEngine.setTrusted(false)
  defaultPermissionPromptChannel.setPermissionPromptHandler(null)
  defaultQuestionPromptChannel.setQuestionPromptHandler(null)
}

test("bridge lifecycle: non-LIFO shutdown restores original default trust/slots (P1)", async () => {
  resetProcessDefaults()
  const permissionHandlerA = async () => "deny"
  const questionHandlerA = async () => ({})
  const kernelA = await createKernel({
    cwd: workDirA,
    config: configWith({ builtinTools: false }),
    trustState: { trusted: true },
    handlers: { onPermissionPrompt: permissionHandlerA, onQuestionPrompt: questionHandlerA }
  })
  const kernelB = await createKernel({
    cwd: workDirB,
    config: configWith({ builtinTools: false }),
    trustState: { trusted: false },
    handlers: { onPermissionPrompt: async () => "deny" }
  })

  // 非 LIFO：先创建的先关。旧实现里这会把默认信任态恢复成 true（信任门静默
  // 打开）、默认审批槽位指向已销毁 kernelA 的死 handler。
  await kernelA.shutdown()
  await kernelB.shutdown()

  assert.equal(PermissionEngine.isTrusted(), false, "default trust must return to its pre-bridge value")
  assert.equal(defaultPermissionPromptChannel.getPermissionPromptHandler(), null, "default permission slot must not point at a destroyed kernel's handler")
  assert.equal(defaultQuestionPromptChannel.getQuestionPromptHandler(), null)
})

test("bridge lifecycle: failed createKernel rolls back bridge, slots and trust (P2-1)", async () => {
  resetProcessDefaults()
  const listenersBefore = defaultEventBus.listenerCount()

  // tool.local_dirs 指向普通文件 → loadDynamicTools 的 readdir 抛 ENOTDIR，
  // boot 失败（现实配置错误，reviewer 复现路径）。
  const notADir = join(workDirA, "not-a-dir.txt")
  await writeFile(notADir, "x")
  const badConfig = configWith({ builtinTools: false })
  badConfig.config.tool.sources.local = true
  badConfig.config.tool.local_dirs = [notADir]

  await assert.rejects(createKernel({
    cwd: workDirA,
    config: badConfig,
    trustState: { trusted: true },
    handlers: { onPermissionPrompt: async () => "allow_session" }
  }))

  // 对称回滚：默认信任态/槽位回到原始值，默认总线上的事件桥无泄漏
  assert.equal(PermissionEngine.isTrusted(), false)
  assert.equal(defaultPermissionPromptChannel.getPermissionPromptHandler(), null)
  assert.equal(defaultQuestionPromptChannel.getQuestionPromptHandler(), null)
  assert.equal(defaultEventBus.listenerCount(), listenersBefore)
})

test("bridge lifecycle: failed shutdown stays retryable and still flushes sessions (P2-2)", async () => {
  // 钉住 P2-2 的两个半边（review round 2 变异验证没过 round 1 的版本）：
  //  - flushNow 必达：断言钉 sessionDataPath —— 只有 flushUnsafe 会写会话数据
  //    文件（touchSession 的迁移/加载路径会 eager 写 session index，钉
  //    sessionIndexPath 不经 flushNow 也能过，round 1 的测试因此钉不住缺陷）
  //  - 失败可重试：失败的 shutdown 之后弄脏第二个会话，再断言重试真的发生了
  //    （旧代码 shutdownDone 提前置位 → 重试 no-op：第二个会话永不落盘、
  //    mcp.shutdown 也不会被再次调用）
  //
  // 防抖窗口：flushIntervalMs 调到 10s，断言全部落在 ~100ms 窗口内，定时器
  // 不可能抢先落盘（100x 余量）。不用 reviewer 建议的 0：实测 0（<=0）会让
  // 所有 mutator eager flush（touchSession 内 if <=0 await flushUnsafe()），
  // 「脏而未落盘」的状态根本造不出来，判别力反而消失。10s 定时器在测试后
  // 自行触发并自清（flushNow 空转），不阻塞套件。
  configureSessionStore({ flushIntervalMs: 10_000 })
  const kernel = await createKernel({
    cwd: workDirA,
    config: configWith({ builtinTools: false }),
    trustState: { trusted: false }
  })
  await kernel.sessions.touchSession({
    sessionId: "ses_p22_a",
    mode: "agent",
    model: "mock-model",
    providerType: "openai",
    cwd: workDirA
  })
  // 防抖窗口内：数据文件尚未落盘
  await assert.rejects(access(sessionDataPath("ses_p22_a")))

  let mcpShutdownCalls = 0
  const mcp = kernel.extensions.mcp
  const originalShutdown = mcp.shutdown
  mcp.shutdown = async () => {
    mcpShutdownCalls += 1
    if (mcpShutdownCalls === 1) throw new Error("mcp shutdown boom")
  }
  try {
    await assert.rejects(kernel.shutdown(), /mcp shutdown boom/)
    // flushNow 在 finally 中必达：首个会话的数据文件即使 mcp 抛错也已写盘
    await access(sessionDataPath("ses_p22_a"))

    // 失败后再弄脏第二个会话 —— 只有真的重试才会把它写盘
    await kernel.sessions.touchSession({
      sessionId: "ses_p22_b",
      mode: "agent",
      model: "mock-model",
      providerType: "openai",
      cwd: workDirA
    })
    await assert.rejects(access(sessionDataPath("ses_p22_b")))
    await kernel.shutdown()
    assert.equal(mcpShutdownCalls, 2, "retry must actually re-run shutdown")
    await access(sessionDataPath("ses_p22_b"))
  } finally {
    mcp.shutdown = originalShutdown
    configureSessionStore({ flushIntervalMs: 1000 })
  }
})
