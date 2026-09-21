import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { PermissionEngine } from "../src/kernel/permission/engine.mjs"
import { ToolRegistry } from "../src/kernel/tool/registry.mjs"
import { SkillRegistry } from "../src/kernel/skill/registry.mjs"
import { CustomAgentRegistry } from "../src/kernel/agent/custom-agent-loader.mjs"
import { bootstrapKernelExtensions } from "../src/context.mjs"

// 1.0.0 阶段 1a 的零行为变更契约（docs/architecture-kernel-sdk-1.0.0.md §6）：
// bootstrapKernelExtensions 收口前，各入口复制的初始化序列是
// PermissionEngine.setTrusted → ToolRegistry.initialize → SkillRegistry.initialize
// → CustomAgentRegistry.initialize → initHookBus。本测试用探针断言该顺序逐字不变。
//
// initHookBus 是命名函数导出（ESM namespace 冻结，无法替换），改用探针 hook 文件：
// initHookBus 加载 <cwd>/.kkcode/hooks/*.mjs 时会执行文件顶层代码，借此把
// "initHookBus" 推进调用序列的正确位置。

function installProbes(calls, seen) {
  const originals = {
    setTrusted: PermissionEngine.setTrusted,
    toolInitialize: ToolRegistry.initialize,
    skillInitialize: SkillRegistry.initialize,
    agentInitialize: CustomAgentRegistry.initialize
  }
  PermissionEngine.setTrusted = (value) => {
    calls.push("permission.setTrusted")
    seen.setTrusted = value
    originals.setTrusted.call(PermissionEngine, value)
  }
  ToolRegistry.initialize = async (options) => {
    calls.push("tool.initialize")
    seen.tool = options
  }
  SkillRegistry.initialize = async (config, cwd, options) => {
    calls.push("skill.initialize")
    seen.skill = { config, cwd, options }
  }
  CustomAgentRegistry.initialize = async (cwd, options) => {
    calls.push("agent.initialize")
    seen.agent = { cwd, options }
  }
  return () => {
    PermissionEngine.setTrusted = originals.setTrusted
    ToolRegistry.initialize = originals.toolInitialize
    SkillRegistry.initialize = originals.skillInitialize
    CustomAgentRegistry.initialize = originals.agentInitialize
  }
}

async function writeProbeHook(cwd) {
  await mkdir(join(cwd, ".kkcode", "hooks"), { recursive: true })
  await writeFile(
    join(cwd, ".kkcode", "hooks", "boot-probe.mjs"),
    "globalThis.__KKCODE_BOOT_PROBE__?.push(\"initHookBus\")\nexport default { name: \"boot-probe\" }\n",
    "utf8"
  )
}

test("kernel bootstrap runs the boot sequence in the pre-consolidation order", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kkcode-boot-order-"))
  const calls = []
  const seen = {}
  const restore = installProbes(calls, seen)
  globalThis.__KKCODE_BOOT_PROBE__ = calls
  try {
    await writeProbeHook(cwd)
    const configState = { config: { compat: {} }, allowProjectSources: true }
    const policy = await bootstrapKernelExtensions({ cwd, configState, trustState: { trusted: true } })

    assert.deepEqual(calls, [
      "permission.setTrusted",
      "tool.initialize",
      "skill.initialize",
      "agent.initialize",
      "initHookBus"
    ])

    // 各注册表收到的参数与收口前各入口手写的完全一致
    assert.equal(seen.setTrusted, true)
    assert.equal(PermissionEngine.isTrusted(), true)
    assert.equal(seen.tool.config, configState.config)
    assert.equal(seen.tool.cwd, cwd)
    assert.equal(seen.tool.allowProjectSources, true)
    assert.equal(seen.skill.config, configState.config)
    assert.equal(seen.skill.cwd, cwd)
    assert.deepEqual(seen.skill.options, { allowProjectSources: true })
    assert.equal(seen.agent.cwd, cwd)
    // M28 r1 review fix: the agent loader's plugin discovery must see the
    // compat policy (compat.plugins.enabled/ecosystems), same as skills/hooks.
    assert.deepEqual(seen.agent.options, { allowProjectSources: true, config: configState.config })
    assert.equal(policy.config, configState.config)
    assert.equal(policy.allowProjectSources, true)
  } finally {
    restore()
    delete globalThis.__KKCODE_BOOT_PROBE__
    await rm(cwd, { recursive: true, force: true })
  }
})

test("kernel bootstrap maps an untrusted workspace onto the extension policy", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kkcode-boot-untrusted-"))
  const calls = []
  const seen = {}
  const restore = installProbes(calls, seen)
  try {
    const configState = {
      config: { layer: "merged" },
      userConfig: { layer: "user" },
      extensionConfig: { layer: "extension" },
      allowProjectSources: false
    }
    const policy = await bootstrapKernelExtensions({ cwd, configState, trustState: { trusted: false } })

    // 未授信时项目源被排除，探针 hook（位于 <cwd>/.kkcode/hooks）不会被加载
    assert.deepEqual(calls, [
      "permission.setTrusted",
      "tool.initialize",
      "skill.initialize",
      "agent.initialize"
    ])
    assert.equal(seen.setTrusted, false)
    assert.equal(PermissionEngine.isTrusted(), false)
    assert.equal(seen.tool.config, configState.extensionConfig)
    assert.equal(seen.tool.allowProjectSources, false)
    assert.equal(seen.skill.config, configState.extensionConfig)
    assert.deepEqual(seen.skill.options, { allowProjectSources: false })
    assert.deepEqual(seen.agent.options, { allowProjectSources: false, config: configState.extensionConfig })
    assert.equal(policy.config, configState.extensionConfig)
  } finally {
    restore()
    await rm(cwd, { recursive: true, force: true })
  }
})
