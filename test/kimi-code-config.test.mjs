import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import YAML from "yaml"
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs"
import { validateConfig } from "../src/config/schema.mjs"
import { VENDOR_PRESETS, createWizardState, handleWizardInput } from "../src/provider/wizard.mjs"

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

test("provider wizard selects an environment variable without accepting a plaintext key", async () => {
  const keys = Object.keys(VENDOR_PRESETS)
  const choice = keys.indexOf("kimi-code") + 1
  const wizard = createWizardState()
  const lines = []
  await handleWizardInput(wizard, String(choice), (line) => lines.push(line))
  assert.equal(wizard.step, "model")
  assert.equal(wizard.apiKeyEnv, "KIMI_CODE_API_KEY")
  assert.equal(wizard.apiKey, undefined)
  assert.match(lines.join("\n"), /不会写入配置/)
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
