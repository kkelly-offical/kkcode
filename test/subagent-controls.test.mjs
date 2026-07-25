import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import { resolveSubagent } from "../src/orchestration/subagent-router.mjs"
import { formatTaskResult } from "../src/tool/task-tool.mjs"

/**
 * 0.6.0 阶段 4：子智能体可控。
 * 三个静默升权与两个死字段，都是「声明了但不生效」这一类。
 */

describe("配置覆盖与注册表定义合并", () => {
  it("只覆盖 model 时，注册表的 permission 与 tools 白名单必须保留", () => {
    // 0.6.0 之前是直接替换：用户想换个模型，explore 的 readonly 与只读工具
    // 白名单一起丢掉，静默升权成全量。
    const resolved = resolveSubagent({
      config: { agent: { subagents: { explore: { model: "cheap-model" } } } },
      subagentType: "explore"
    })
    assert.equal(resolved.model, "cheap-model")
    assert.equal(resolved.permission, "readonly", "权限档不能被覆盖掉")
    assert.ok(Array.isArray(resolved.tools) && resolved.tools.includes("read"), "tools 白名单不能丢")
  })

  it("显式声明的字段仍然优先于注册表", () => {
    const resolved = resolveSubagent({
      config: { agent: { subagents: { explore: { permission: "full" } } } },
      subagentType: "explore"
    })
    assert.equal(resolved.permission, "full")
  })

  it("maxTurns 会被带出来 —— bug-hunter 的 30 步不再被 8 步封顶", () => {
    const resolved = resolveSubagent({ config: {}, subagentType: "bug-hunter" })
    assert.equal(resolved.maxTurns, 30)
  })

  it('model: "inherit" 归一为 null，不会被当成模型名发给 provider', () => {
    const resolved = resolveSubagent({
      config: { agent: { subagents: { helper: { model: "inherit" } } } },
      subagentType: "helper"
    })
    assert.equal(resolved.model, null)
  })

  it("未知类型在已配置 subagents 时返回结构化 fallback，供调用方显式报错", () => {
    const resolved = resolveSubagent({
      config: { agent: { subagents: { known: {} } } },
      subagentType: "nope"
    })
    assert.equal(resolved.fallback, true)
    assert.match(resolved.reason, /unknown subagent_type/)
  })
})

describe("委派结果的序列化", () => {
  it("reply 是主体，元数据压在尾部（不再整个对象 JSON 化后被砍）", () => {
    const formatted = formatTaskResult({
      session_id: "sub_1",
      subagent: "explore",
      reply: "找到了三处调用点",
      tool_events: 4,
      file_changes: [{ path: "src/a.mjs" }]
    })
    assert.match(formatted.output, /^找到了三处调用点/)
    assert.match(formatted.output, /subagent: explore/)
    assert.match(formatted.output, /src\/a\.mjs/)
    assert.equal(formatted.metadata.session_id, "sub_1")
  })

  it("后台句柄与错误对象原样返回 —— 它们的结构就是给模型的操作指引", () => {
    const handle = { background_task_id: "bg_1", status: "running" }
    assert.deepEqual(formatTaskResult(handle), handle)
    const failure = { error: "boom" }
    assert.deepEqual(formatTaskResult(failure), failure)
  })
})
