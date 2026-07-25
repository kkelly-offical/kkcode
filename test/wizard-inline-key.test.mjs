import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import YAML from "yaml"

/**
 * Issue #3：配置里写了内联 api_key 时，provider 向导只查环境变量。
 *
 * 两个缺陷同源同修：
 *  1. 发现守卫只看 `process.env[api_key_env]`，`entry.api_key` 从未被查 ——
 *     用户明明配好了密钥，向导却报「环境变量未设置」拒绝拉模型目录。
 *  2. 写回用 Object.assign 整条目替换 —— 对已有 provider 重跑向导会把
 *     内联 api_key、timeout、models 列表等没动过的字段全部抹掉。
 */

const tmpHome = await mkdtemp(path.join(os.tmpdir(), "kkcode-wizard-key-"))
process.env.KKCODE_HOME = tmpHome

const { VENDOR_PRESETS, createWizardState, handleWizardInput } = await import("../src/provider/wizard.mjs")

const KIMI_INDEX = Object.keys(VENDOR_PRESETS).indexOf("kimi-code") + 1
assert.ok(KIMI_INDEX > 0, "kimi-code 预设必须存在")

test.after(async () => {
  delete process.env.KKCODE_HOME
  await rm(tmpHome, { recursive: true, force: true }).catch(() => {})
})

test("发现模型目录：内联 api_key 存在时不再要求环境变量", async () => {
  delete process.env.KIMI_CODE_API_KEYS // 确保干扰不存在
  delete process.env.KIMI_CODE_API_KEY

  const wizard = createWizardState()
  wizard.active = true
  wizard.step = "vendor"
  const lines = []
  const discovered = []
  const options = {
    // 向导现在能看到现有配置 —— REPL 从 ctx.configState 传入
    existingProviders: {
      "kimi-code": { api_key: "sk-kimi-inline-secret", base_url: "https://api.kimi.com/coding/v1" }
    },
    discoverModels: async (configState) => {
      discovered.push(configState.config.provider["kimi-code"])
      return { models: [{ id: "k3" }, { id: "kimi-for-coding" }], source: "network", stale: false }
    }
  }
  const input = (value) => handleWizardInput(wizard, value, (line) => lines.push(line), options)

  await input(String(KIMI_INDEX))

  // 0.5.0 之前这里止步于「环境变量 KIMI_CODE_API_KEY 未设置」
  assert.equal(wizard.discoveryError, null, `不该报错：${wizard.discoveryError}`)
  assert.deepEqual(wizard.discoveredModels, ["k3", "kimi-for-coding"])
  assert.equal(discovered[0].api_key, "sk-kimi-inline-secret", "内联密钥必须传进发现请求")
  assert.match(lines.join("\n"), /检测到配置中已有该 provider 的 api_key/)
})

test("发现模型目录：既无内联密钥也无环境变量时，错误信息给出两条出路", async () => {
  delete process.env.KIMI_CODE_API_KEY
  const wizard = createWizardState()
  wizard.active = true
  wizard.step = "vendor"
  const lines = []
  const input = (value) => handleWizardInput(wizard, value, (line) => lines.push(line), {
    existingProviders: {},
    discoverModels: async () => { throw new Error("should not be called") }
  })

  await input(String(KIMI_INDEX))
  assert.match(wizard.discoveryError, /环境变量.*未设置.*没有 api_key/)
  assert.match(lines.join("\n"), /api_key/, "提示里要告诉用户可以在配置里写内联密钥")
  assert.equal(wizard.step, "model", "仍可手动输入模型 ID")
})

test("写回配置：向导没动的字段（api_key / timeout / models）原样保留", async () => {
  // 预置一份带内联密钥与调优字段的配置
  const configPath = path.join(tmpHome, "config.yaml")
  await mkdir(tmpHome, { recursive: true })
  await writeFile(configPath, YAML.stringify({
    provider: {
      default: "kimi-code",
      "kimi-code": {
        type: "openai-compatible",
        base_url: "https://api.kimi.com/coding/v1",
        api_key: "sk-kimi-inline-secret",
        default_model: "kimi-for-coding",
        models: ["k3", "kimi-for-coding"],
        timeout_ms: 180000,
        retry_attempts: 3
      },
      aliyun: { type: "openai-compatible", base_url: "https://x/v1", api_key: "sk-other" }
    }
  }), "utf8")

  const wizard = createWizardState()
  wizard.active = true
  wizard.step = "vendor"
  const options = {
    existingProviders: YAML.parse(await readFile(configPath, "utf8")).provider,
    discoverModels: async () => ({ models: [{ id: "k3" }, { id: "k3-256k" }], source: "network", stale: false })
  }
  const input = (value) => handleWizardInput(wizard, value, () => {}, options)

  await input(String(KIMI_INDEX))   // 选 kimi-code → 发现成功（内联密钥）
  await input("2")                  // 选 k3-256k 为默认模型
  await input("0")                  // context limit 默认
  await input("n")                  // thinking 关闭
  assert.equal(wizard.step, "confirm")
  await input("y")                  // 保存

  const saved = YAML.parse(await readFile(configPath, "utf8"))
  const entry = saved.provider["kimi-code"]
  // 向导设置的字段生效
  assert.equal(entry.default_model, "k3-256k")
  // 0.5.0 之前这三行会失败：整条目替换把它们全抹了
  assert.equal(entry.api_key, "sk-kimi-inline-secret", "内联密钥不能被向导抹掉")
  assert.equal(entry.timeout_ms, 180000, "调优字段不能被向导抹掉")
  assert.deepEqual(entry.models, ["k3", "kimi-for-coding"], "models 列表不能被向导抹掉")
  // 其它 provider 不受影响
  assert.equal(saved.provider.aliyun.api_key, "sk-other")
})
