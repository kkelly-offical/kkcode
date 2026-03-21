import test from "node:test"
import assert from "node:assert/strict"
import { buildProviderConfig, createWizardState, VENDOR_PRESETS } from "../src/provider/wizard.mjs"

test("provider wizard persists api_key_env when skipping inline key", () => {
  const wiz = createWizardState()
  wiz.vendorKey = "openrouter"
  wiz.preset = VENDOR_PRESETS.openrouter
  wiz.defaultModel = VENDOR_PRESETS.openrouter.default_model
  const config = buildProviderConfig(wiz)
  assert.equal(config.provider.default, "openrouter")
  assert.equal(config.provider.openrouter.api_key_env, "OPENROUTER_API_KEY")
  assert.equal(config.provider.openrouter.headers["HTTP-Referer"], "https://kkcode.chat")
})

test("provider wizard keeps inline api_key when provided", () => {
  const wiz = createWizardState()
  wiz.vendorKey = "deepseek"
  wiz.preset = VENDOR_PRESETS.deepseek
  wiz.apiKey = "sk-inline"
  wiz.defaultModel = VENDOR_PRESETS.deepseek.default_model
  const config = buildProviderConfig(wiz)
  assert.equal(config.provider.deepseek.api_key, "sk-inline")
  assert.equal(config.provider.deepseek.api_key_env, undefined)
  assert.equal(config.provider.deepseek.base_url, "https://api.deepseek.com/v1")
})

test("provider wizard emits complete coding-plan config from catalog preset", () => {
  const wiz = createWizardState()
  wiz.vendorKey = "coding-plan"
  wiz.preset = VENDOR_PRESETS["coding-plan"]
  wiz.defaultModel = VENDOR_PRESETS["coding-plan"].default_model
  const config = buildProviderConfig(wiz)
  assert.equal(config.provider.default, "coding-plan")
  assert.equal(config.provider["coding-plan"].type, "openai-compatible")
  assert.equal(config.provider["coding-plan"].base_url, "https://coding.dashscope.aliyuncs.com/v1")
  assert.equal(config.provider["coding-plan"].api_key_env, "CODING_PLAN_API_KEY")
  assert.equal(config.provider["coding-plan"].context_limit, 983616)
})
