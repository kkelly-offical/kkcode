import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import YAML from "yaml"
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs"
import { validateConfig } from "../src/config/schema.mjs"
import { VENDOR_PRESETS } from "../src/provider/wizard.mjs"
import { runProviderAddForm } from "../src/provider/wizard-form.mjs"

test("official Kimi Code preset uses coding endpoint and environment credential", async () => {
  const preset = DEFAULT_CONFIG.provider["kimi-code"]
  assert.equal(preset.base_url, "https://api.kimi.com/coding/v1")
  assert.equal(preset.api_key_env, "KIMI_CODE_API_KEY")
  assert.equal(preset.default_model, "k3")
  assert.ok(preset.models.includes("kimi-for-coding"))
  assert.equal(DEFAULT_CONFIG.provider.model_context.k3, 1048576)
  assert.equal(VENDOR_PRESETS["kimi-code"].key_env, "KIMI_CODE_API_KEY")

  const template = YAML.parse(await readFile(new URL("../configs/config-kimi-code.yaml", import.meta.url), "utf8"))
  assert.equal(template.provider.default, "kimi-code")
  assert.equal(template.provider["kimi-code"].api_key, undefined)
  assert.equal(validateConfig(template).valid, true)
})

test("the form accepts a plaintext key for kimi-code and records the env var only when the key is blank", async () => {
  // 0.7.3 之前这条断言的是**反面**（「向导不接受明文 key」）—— 那正是用户要求
  // 推翻的行为：跑完整个向导仍然配不上凭据。现在两条路都要成立：
  //   填了 key  → 写 api_key（明文），不写 api_key_env
  //   留空      → 写 api_key_env（预设的 KIMI_CODE_API_KEY），不写 api_key
  const run = (apiKey) => runProviderAddForm({
    configState: { config: { provider: {} } },
    ask: async ({ questions }) => Object.fromEntries(questions.map((q) => {
      if (q.id === "vendor") return [q.id, "kimi-code"]
      if (q.id === "api_key") return [q.id, apiKey]
      if (q.id === "model") return [q.id, "k3"]
      if (q.id === "confirm") return [q.id, "save"]
      if (q.id === "thinking") return [q.id, "skip"]
      return [q.id, q.default ?? ""]
    })),
    discover: async () => ({ models: [{ id: "k3" }] })
  })

  const withKey = await run("sk-kimi-direct")
  assert.equal(withKey.configPatch.provider["kimi-code"].api_key, "sk-kimi-direct")
  assert.equal(withKey.configPatch.provider["kimi-code"].api_key_env, undefined)

  const withoutKey = await run("")
  assert.equal(withoutKey.configPatch.provider["kimi-code"].api_key, undefined)
  assert.equal(withoutKey.configPatch.provider["kimi-code"].api_key_env, "KIMI_CODE_API_KEY")

  // kimi-code 预设自带 context_limit: 1048576 —— 正是「静默继承」最容易复发的
  // 地方：用户在表单里留空，写盘却出现预设值。custom vendor 的用例抓不到这个
  // （它们没有预设默认值），必须在带默认值的厂商上钉。
  assert.equal(withKey.configPatch.provider["kimi-code"].context_limit, undefined,
    "留空的 context_limit 不得从预设继承进配置文件")
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
