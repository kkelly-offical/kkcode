import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { validateConfig } from "../src/config/schema.mjs"
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs"
import { loadConfig } from "../src/config/load-config.mjs"
import { buildPreflightReport, PREFLIGHT_FAIL, PREFLIGHT_OK } from "../src/cli/preflight.mjs"

/**
 * 0.5.6：三个让配置「静默失效」的缺陷。共同的坏味道是失败没有声音 ——
 * 校验器拒绝整份文件、别名把键送到没人读的位置、自检读了一个不存在的
 * 字段，三者都不产生任何用户可见信号。
 */

const tmpHome = await mkdtemp(path.join(os.tmpdir(), "kkcode-cfgwire-home-"))
const originalHome = process.env.KKCODE_HOME
process.env.KKCODE_HOME = tmpHome

test.after(async () => {
  if (originalHome === undefined) delete process.env.KKCODE_HOME
  else process.env.KKCODE_HOME = originalHome
  await rm(tmpHome, { recursive: true, force: true }).catch(() => {})
})

async function withProjectConfig(yaml, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-cfgwire-proj-"))
  try {
    await mkdir(path.join(dir, ".kkcode"), { recursive: true })
    await writeFile(path.join(dir, ".kkcode", "config.yaml"), yaml, "utf8")
    return await fn(await loadConfig(dir))
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

describe("默认配置自证合法", () => {
  it("DEFAULT_CONFIG 必须通过自己的 schema", () => {
    // 这条不变量一旦破，任何显式写出该键的用户配置都会被整份丢弃 ——
    // models.ultra 就是这样从 0.5.0 一路坏到 0.5.5 的。
    const result = validateConfig(DEFAULT_CONFIG)
    assert.equal(result.valid, true, `默认配置不合法: ${result.errors.join("; ")}`)
  })
})

describe("models.ultra 分阶段模型", () => {
  it("合法的分阶段覆盖不再被当成未知角色", () => {
    const result = validateConfig({ models: { main: "m", ultra: { report: "r", coding: null } } })
    assert.equal(result.valid, true, result.errors.join("; "))
  })

  it("拼错的阶段名报错，且错在具体的键上", () => {
    const result = validateConfig({ models: { ultra: { reporrt: "r" } } })
    assert.equal(result.valid, false)
    assert.match(result.errors.join(";"), /models\.ultra\.reporrt: unknown stage/)
  })

  it("阶段值必须是字符串或 null", () => {
    assert.equal(validateConfig({ models: { ultra: { coding: 42 } } }).valid, false)
    assert.equal(validateConfig({ models: { ultra: "nope" } }).valid, false)
  })

  it("端到端：写进 YAML 的 models.ultra 真的读得到，且不牵连同文件其他键", async () => {
    await withProjectConfig("models:\n  main: main-model\n  ultra:\n    report: report-model\n", (state) => {
      assert.deepEqual(state.errors, [], "整份配置不该被丢弃")
      assert.equal(state.config.models.ultra.report, "report-model")
      assert.equal(state.config.models.main, "main-model")
    })
  })
})

describe("agent.ultra 下的 goal 模式键自动归位", () => {
  it("agent.ultra.goal_mode 落到运行时真正读取的位置", async () => {
    await withProjectConfig("agent:\n  ultra:\n    goal_mode: false\n    max_rounds: 3\n", (state) => {
      const longagent = state.config.agent.longagent
      assert.equal(longagent.ultra.goal_mode, false, "逃生阀必须真的关得掉")
      assert.equal(longagent.ultra.max_rounds, 3)
      assert.equal(longagent.goal_mode, undefined, "错位的键不该留在顶层")
    })
  })

  it("已经写对位置的值优先于错位的值", async () => {
    await withProjectConfig("agent:\n  ultra:\n    goal_mode: true\n    ultra:\n      goal_mode: false\n", (state) => {
      assert.equal(state.config.agent.longagent.ultra.goal_mode, false)
    })
  })

  it("longagent 自身的键不会被误搬进 ultra 段", async () => {
    await withProjectConfig("agent:\n  longagent:\n    max_iterations: 7\n    ultra:\n      max_rounds: 2\n", (state) => {
      const longagent = state.config.agent.longagent
      assert.equal(longagent.max_iterations, 7, "顶层的合法键必须留在顶层")
      assert.equal(longagent.ultra.max_iterations, undefined)
      assert.equal(longagent.ultra.max_rounds, 2)
    })
  })
})

describe("preflight 不再对被丢弃的配置报 ok", () => {
  const base = { source: { userPath: "/u/config.yaml", projectPath: null }, config: DEFAULT_CONFIG }

  it("configState.errors 非空 → FAIL，并说清文件被整份忽略", () => {
    const report = buildPreflightReport({
      configState: { ...base, errors: ["/u/config.yaml: models.zzz: unknown role"] }
    })
    assert.equal(report.checks.config.status, PREFLIGHT_FAIL)
    assert.match(report.checks.config.detail, /unknown role/)
    assert.match(report.checks.config.detail, /整份忽略/)
    assert.equal(report.status, PREFLIGHT_FAIL, "整体状态必须变红，否则退出码仍是 0")
  })

  it("没有错误时照常 ok", () => {
    const report = buildPreflightReport({ configState: { ...base, errors: [] } })
    assert.equal(report.checks.config.status, PREFLIGHT_OK)
  })
})
