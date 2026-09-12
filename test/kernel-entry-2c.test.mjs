// 1.0.0 阶段 2c（§6）：createKernel 吸收 buildContext 平台侧之后的入口契约面 ——
// boot:false 推迟引导、bootExtensions() 补引导、applyTrustState() 承载
// /trust /untrust（M3 耦合点 6：五套注册表重建收进 kernel 句柄方法）、
// trustState 缺省时按原 buildContext 语义探测持久化信任存储。
import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, access, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createKernel } from "../src/kernel/index.mjs"
// 观察 2b 桥对进程级默认值的作用，直接引用默认引擎（与 kernel-multi-instance 同款做法）
import { PermissionEngine } from "../src/permission/engine.mjs"
import { trustFilePath } from "../src/storage/paths.mjs"

let homeDir
let workDir

before(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "kkcode-kernel-2c-home-"))
  workDir = await mkdtemp(join(tmpdir(), "kkcode-kernel-2c-cwd-"))
  process.env.KKCODE_HOME = homeDir
})

after(async () => {
  delete process.env.KKCODE_HOME
  await rm(homeDir, { recursive: true, force: true })
  await rm(workDir, { recursive: true, force: true })
})

function entryConfig() {
  return {
    source: {},
    config: {
      provider: { default: "openai" },
      agent: { default_mode: "agent", max_steps: 3 },
      permission: { level: "yolo", rules: [] },
      session: { max_history: 10, recovery: false },
      tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } },
      usage: { aggregation: ["turn"], budget: {} },
      ui: { markdown_render: false }
    }
  }
}

test("boot:false defers extension boot; bootExtensions() runs it exactly once", async () => {
  const kernel = await createKernel({
    cwd: workDir,
    config: entryConfig(),
    trustState: { trusted: true },
    boot: false
  })
  try {
    // 只读巡检形态：注册表未引导，策略已解析（不 spawn MCP、不写技能种子）
    assert.equal(kernel.tools.isReady(), false)
    assert.equal(kernel.extensionPolicy.allowProjectSources, true)

    const policy = await kernel.bootExtensions()
    assert.equal(kernel.tools.isReady(), true)
    assert.ok((await kernel.tools.list({ mode: "agent" })).length > 0)
    assert.equal(policy, kernel.extensionPolicy)

    // 幂等：第二次调用不再重复引导（返回值同一引用）
    const again = await kernel.bootExtensions()
    assert.equal(again, policy)
  } finally {
    await kernel.shutdown()
  }
})

test("applyTrustState flips trust on instance and default engines and rebuilds policy", async () => {
  const baselineTrust = PermissionEngine.isTrusted()
  const kernel = await createKernel({
    cwd: workDir,
    config: entryConfig(),
    trustState: { trusted: false }
  })
  try {
    assert.equal(kernel.permissions.isTrusted(), false)
    assert.equal(PermissionEngine.isTrusted(), false, "2b 桥：默认引擎跟着未授信")
    assert.equal(kernel.extensionPolicy.allowProjectSources, false)
    const untrustedTools = (await kernel.tools.list({ mode: "agent" })).length

    // /trust：实例与默认两侧的信任态、策略与注册表一起翻转（不再手工重建五套）
    await kernel.applyTrustState({ trusted: true })
    assert.equal(kernel.trustState.trusted, true)
    assert.equal(kernel.permissions.isTrusted(), true)
    assert.equal(PermissionEngine.isTrusted(), true, "2b 桥：默认引擎跟着授信")
    assert.equal(kernel.extensionPolicy.allowProjectSources, true)
    assert.ok(kernel.tools.isReady())
    assert.ok((await kernel.tools.list({ mode: "agent" })).length >= untrustedTools)

    // /untrust 对称
    await kernel.applyTrustState({ trusted: false })
    assert.equal(kernel.permissions.isTrusted(), false)
    assert.equal(PermissionEngine.isTrusted(), false)
    assert.equal(kernel.extensionPolicy.allowProjectSources, false)
  } finally {
    await kernel.shutdown()
  }
  assert.equal(PermissionEngine.isTrusted(), baselineTrust, "shutdown 后默认信任态恢复原始值")
})

test("createKernel without trustState probes the persisted trust store (buildContext parity)", async () => {
  // trust:true 等价命令行 --trust：授信并持久化（M10 的 {trusted: trust===true}
  // 默认值不落盘 —— chat --trust 的持久化会丢，2c 吸收探测后恢复逐字语义）
  const kernel = await createKernel({
    cwd: workDir,
    config: entryConfig(),
    trust: true,
    boot: false
  })
  assert.equal(kernel.trustState.trusted, true)
  await kernel.shutdown()

  const stored = JSON.parse(await readFile(trustFilePath(workDir), "utf8"))
  assert.equal(stored.trusted, true)

  // 第二个 kernel 不传 trust/trustState：从持久化存储探到已授信
  const probed = await createKernel({ cwd: workDir, config: entryConfig(), boot: false })
  try {
    assert.equal(probed.trustState.trusted, true, "持久化信任存储应被探测到")
    assert.equal(probed.extensionPolicy.allowProjectSources, true)
  } finally {
    await probed.shutdown()
  }
  await access(trustFilePath(workDir))
})
