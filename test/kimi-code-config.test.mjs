import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import YAML from "yaml"
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs"
import { validateConfig } from "../src/config/schema.mjs"
import { VENDOR_PRESETS } from "../src/provider/wizard.mjs"
import { runProviderAddForm } from "../src/provider/wizard-form.mjs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("official Kimi Code preset uses coding endpoint and environment credential", async () => {
  // 0.7.3 起 DEFAULT_CONFIG 不再预置 provider 条目（用户有什么就显示什么）；
  // 0.8.0 起 /provider add 表单也去模板化了 —— VENDOR_PRESETS 只剩 CLI 列表的
  // label 装饰这一个用途，但厂商知识（正确的 URL/模型名）仍值得钉住不腐化。
  const preset = VENDOR_PRESETS["kimi-code"]
  assert.equal(preset.base_url, "https://api.kimi.com/coding/v1")
  assert.equal(preset.key_env, "KIMI_CODE_API_KEY")
  assert.equal(preset.default_model, "k3")
  assert.ok(preset.models.includes("kimi-for-coding"))
  assert.equal(DEFAULT_CONFIG.provider["kimi-code"], undefined, "预置条目不得回潮")
  assert.equal(DEFAULT_CONFIG.provider.model_context.k3, 1048576, "模型知识库保留")

  const template = YAML.parse(await readFile(new URL("../configs/config-kimi-code.yaml", import.meta.url), "utf8"))
  assert.equal(template.provider.default, "kimi-code")
  assert.equal(template.provider["kimi-code"].api_key, undefined)
  assert.equal(validateConfig(template).valid, true)
})

test("the form accepts a plaintext key and writes no credential field at all when blank", async () => {
  /**
   * 事故记录（2026-07-28）：这条测试此前**没有隔离 KKCODE_HOME**，而它的
   * confirm: "save" 会让 runProviderAddForm 真的调 saveProviderConfig ——
   * 于是假密钥 "sk-kimi-direct" 被写进了开发者真实的 ~/.kkcode/config.yaml，
   * 把真凭据整个覆盖（401 排查了一圈才找到）。**凡是会走到写盘的表单测试，
   * KKCODE_HOME 必须指向临时目录**，没有例外。
   */
  const home = await mkdtemp(path.join(os.tmpdir(), "kkcode-kimi-form-"))
  const prevHome = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = home
  try {
  // 0.7.3 之前这条断言的是**反面**（「向导不接受明文 key」）。0.8.0 去模板化后
  // 两条路是：
  //   填了 key  → 写 api_key（明文），不写 api_key_env
  //   留空      → 什么凭据字段都不写（没有预设，也就没有环境变量名可以静默塞入）
  const run = (apiKey) => runProviderAddForm({
    configState: { config: { provider: {} } },
    ask: async ({ questions }) => Object.fromEntries(questions.map((q) => {
      if (q.id === "protocol") return [q.id, "openai"]
      if (q.id === "base_url") return [q.id, "https://api.kimi.com/coding/v1"]
      if (q.id === "api_key") return [q.id, apiKey]
      if (q.id === "model") return [q.id, "k3"]
      if (q.id === "confirm") return [q.id, "save"]
      return [q.id, q.default ?? ""]
    })),
    discover: async () => ({ models: [{ id: "k3" }] })
  })

  const withKey = await run("sk-kimi-direct")
  assert.equal(withKey.name, "kimi", "名称从 api.kimi.com 推导")
  assert.equal(withKey.configPatch.provider.kimi.api_key, "sk-kimi-direct")
  assert.equal(withKey.configPatch.provider.kimi.api_key_env, undefined)

  const withoutKey = await run("")
  assert.equal(withoutKey.configPatch.provider.kimi.api_key, undefined)
  assert.equal(withoutKey.configPatch.provider.kimi.api_key_env, undefined,
    "0.8.0：没有模板 → 没有可以静默写入的环境变量名")

  // 0.7.x 的「静默继承」形态：用户没答过的 context_limit 出现在写盘里。
  // 去模板化后不存在继承源，这条钉子仍然要在 —— 它挡的是任何背着用户写字段的回潮。
  assert.equal(withKey.configPatch.provider.kimi.context_limit, undefined,
    "用户没答过的 context_limit 不得出现在配置里")
  } finally {
    if (prevHome === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = prevHome
    await rm(home, { recursive: true, force: true })
  }
})

test("provider schema validates model and reasoning fields", () => {
  const result = validateConfig({
    config_version: 1,
    provider: {
      default: "custom",
      custom: {
        type: "openai-compatible",
        models: ["k3"],
        max_tokens: 100,
        stream_idle_timeout_ms: 1000,
        reasoning_effort: "high"
      }
    }
  })
  assert.equal(result.valid, true)
  assert.equal(validateConfig({
    provider: { default: "custom", custom: { reasoning_effort: "extreme" } }
  }).valid, false)
})
