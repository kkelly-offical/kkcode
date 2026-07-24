import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import YAML from "yaml"
import { VENDOR_PRESETS, createWizardState, handleWizardInput } from "../src/provider/wizard.mjs"
import { loadProviderModelItems } from "../src/repl.mjs"

test("provider wizard discovers gateway models and saves only the selected default", async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "kkcode-wizard-models-"))
  process.env.KKCODE_HOME = temporaryHome
  process.env.TEST_WIZARD_KEY = "test-key"
  const wizard = createWizardState()
  const lines = []
  let discoveredConfig = null
  const options = {
    discoverModels: async (configState) => {
      discoveredConfig = configState.config
      return {
        models: [{ id: "gateway-a" }, { id: "gateway-b" }],
        source: "network",
        stale: false
      }
    }
  }
  const input = async (value) => handleWizardInput(wizard, value, (line) => lines.push(line), options)
  try {
    await input(String(Object.keys(VENDOR_PRESETS).length + 3))
    assert.equal(wizard.step, "custom_protocol")
    await input("1")
    await input("company-gateway")
    await input("https://gateway.example/v1")
    await input("TEST_WIZARD_KEY")

    assert.equal(wizard.step, "model")
    assert.deepEqual(wizard.discoveredModels, ["gateway-a", "gateway-b"])
    assert.equal(discoveredConfig.provider["company-gateway"].type, "gateway")
    assert.equal(discoveredConfig.provider["company-gateway"].protocol, "openai")
    assert.match(lines.join("\n"), /gateway-b/)

    await input("2")
    assert.equal(wizard.defaultModel, "gateway-b")
    await input("0")
    assert.equal(wizard.step, "confirm")
    await input("y")

    const saved = YAML.parse(await readFile(path.join(temporaryHome, "config.yaml"), "utf8"))
    const provider = saved.provider["company-gateway"]
    assert.equal(provider.type, "gateway")
    assert.equal(provider.protocol, "openai")
    assert.equal(provider.default_model, "gateway-b")
    assert.equal(provider.models, undefined)
  } finally {
    delete process.env.TEST_WIZARD_KEY
    delete process.env.KKCODE_HOME
    await rm(temporaryHome, { recursive: true, force: true })
  }
})

test("provider wizard requires explicit manual input when discovery cannot run", async () => {
  const wizard = createWizardState()
  const lines = []
  const input = (value) => handleWizardInput(wizard, value, (line) => lines.push(line))

  await input(String(Object.keys(VENDOR_PRESETS).length + 1))
  await input("offline-gateway")
  await input("https://offline.example/v1")
  await input("UNSET_WIZARD_API_KEY")
  assert.equal(wizard.step, "model")
  assert.equal(wizard.defaultModel, null)
  assert.deepEqual(wizard.discoveredModels, [])

  await input("0")
  assert.equal(wizard.step, "model")
  assert.equal(wizard.defaultModel, null)
  await input("manual-model")
  assert.equal(wizard.step, "context")
  assert.equal(wizard.defaultModel, "manual-model")
  assert.match(lines.join("\n"), /必须明确输入模型 ID/)
})

test("provider wizard can discover an authentication-free local gateway", async () => {
  const wizard = createWizardState()
  let observedProvider = null
  const input = (value) => handleWizardInput(wizard, value, () => {}, {
    discoverModels: async (configState) => {
      observedProvider = configState.config.provider.local
      return { models: [{ id: "local-model" }], source: "network", stale: false }
    }
  })
  await input(String(Object.keys(VENDOR_PRESETS).length + 3))
  await input("1")
  await input("local")
  await input("http://127.0.0.1:8080/v1")
  await input("-")
  assert.equal(observedProvider.api_key_env, undefined)
  assert.deepEqual(wizard.discoveredModels, ["local-model"])
})

test("REPL model items use only the requested dynamic provider catalog", async () => {
  const calls = []
  const configState = {
    config: {
      provider: {
        default: "one",
        one: { models: ["hardcoded-must-not-be-used"] },
        two: { models: ["other-provider"] }
      }
    },
    source: { userRaw: {}, projectRaw: {}, envOverlay: {} }
  }
  const result = await loadProviderModelItems(configState, "one", {
    refresh: true,
    discover: async (_state, options) => {
      calls.push(options)
      return {
        models: [{ id: "live-a" }, { id: "live-a" }, { id: "live-b" }],
        source: "network",
        stale: false
      }
    }
  })
  assert.deepEqual(result.items.map((item) => item.model), ["live-a", "live-b"])
  assert.equal(calls[0].providerName, "one")
  assert.equal(calls[0].refresh, true)
})

test("REPL model items do not fall back to effective hardcoded arrays on discovery failure", async () => {
  const result = await loadProviderModelItems({
    config: {
      provider: {
        default: "openai",
        openai: { models: ["system-default"] }
      }
    },
    source: { userRaw: {}, projectRaw: {}, envOverlay: {} }
  }, "openai", {
    discover: async () => {
      throw new Error("offline")
    }
  })
  assert.deepEqual(result.items, [])
  assert.equal(result.error, "offline")
})
