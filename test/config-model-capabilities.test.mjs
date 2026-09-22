import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PROVIDER_META_KEYS, validateConfig } from "../src/config/schema.mjs"

const tmpHome = await mkdtemp(path.join(os.tmpdir(), "kkcode-caps-config-"))
process.env.KKCODE_HOME = tmpHome

const { runProviderAddForm, previewEntry } = await import("../src/kernel/provider/wizard-form.mjs")

test.after(async () => {
  delete process.env.KKCODE_HOME
  await rm(tmpHome, { recursive: true, force: true }).catch(() => {})
})

// ── schema ───────────────────────────────────────────────────────────

test("model_capabilities is a provider meta key, never a provider entry", () => {
  assert.ok(PROVIDER_META_KEYS.includes("model_capabilities"))
  // 元键不该成为 default 的合法取值
  const invalid = validateConfig({
    provider: {
      default: "model_capabilities",
      model_capabilities: { "gpt-4o": { image: true } }
    }
  })
  assert.equal(invalid.valid, false)
  assert.ok(invalid.errors.some((error) => error.includes("provider.default")))
})

test("model_capabilities schema accepts known boolean flags and rejects the rest", () => {
  const good = validateConfig({
    provider: {
      default: "p",
      p: { type: "openai-compatible", base_url: "https://p.example/v1" },
      model_capabilities: {
        "gpt-4o": { image: true, video: false, tools: true, streaming: true, reasoning: false }
      }
    }
  })
  assert.equal(good.valid, true, good.errors.join(", "))

  const badValue = validateConfig({
    provider: { model_capabilities: { "gpt-4o": { image: "yes" } } }
  })
  assert.equal(badValue.valid, false)
  assert.ok(badValue.errors.some((error) => error.includes("must be boolean")))

  const badKey = validateConfig({
    provider: { model_capabilities: { "gpt-4o": { hologram: true } } }
  })
  assert.equal(badKey.valid, false)
  assert.ok(badKey.errors.some((error) => error.includes("unknown capability")))

  const badShape = validateConfig({ provider: { model_capabilities: { "gpt-4o": true } } })
  assert.equal(badShape.valid, false)
  assert.ok(badShape.errors.some((error) => error.includes("must be object")))
})

// ── /provider add：探测到的能力随确认页落盘 ───────────────────────────

const scriptedAsk = (answerBook) => async ({ questions }) => {
  const out = {}
  for (const q of questions) {
    out[q.id] = Object.prototype.hasOwnProperty.call(answerBook, q.id)
      ? answerBook[q.id]
      : (q.default ?? "")
  }
  return out
}

test("provider add writes discovered capabilities to provider.model_capabilities", async () => {
  const result = await runProviderAddForm({
    configState: { config: { provider: {} } },
    ask: scriptedAsk({
      protocol: "openai",
      base_url: "https://api.bigmodel.cn/paas/v4",
      api_key: "sk-probe-secret",
      model: "glm-5.1, glm-5.1-flash",
      default_model: "glm-5.1",
      confirm: "save"
    }),
    discover: async () => ({
      models: [
        {
          id: "glm-5.1",
          contextLength: 200000,
          capabilities: { image: true, video: false, audio: false, tools: true, streaming: true }
        },
        { id: "glm-5.1-flash", capabilities: { tools: true } }
      ]
    })
  })
  assert.equal(result.saved, true)
  const written = result.configPatch.provider.model_capabilities
  assert.deepEqual(written["glm-5.1"], { image: true, video: false, audio: false, tools: true, streaming: true })
  // 目录只报了 tools；image 由 glm-5 名字族启发式补上（探测不到的键才轮到启发式）
  assert.deepEqual(written["glm-5.1-flash"], { image: true, tools: true })
})

test("provider add writes nothing when capabilities are undeterminable", async () => {
  const result = await runProviderAddForm({
    configState: { config: { provider: {} } },
    ask: scriptedAsk({
      protocol: "openai",
      base_url: "https://mystery.example.test/v1",
      api_key: "sk-x",
      model: "mystery-9000",
      confirm: "save"
    }),
    discover: async () => ({ models: [{ id: "mystery-9000" }] })
  })
  assert.equal(result.saved, true)
  assert.equal(result.configPatch.provider.model_capabilities, undefined,
    "unknown capability = absent key (runtime stays permissive), not a fabricated value")
})

test("the confirmation preview lists exactly the capability flags that will be written", () => {
  const preview = previewEntry("p", {
    type: "openai-compatible",
    base_url: "https://p.example/v1",
    default_model: "m",
    models: ["m"]
  }, {
    modelCapabilities: { m: { image: true, video: false, tools: true } }
  })
  assert.match(preview, /provider\.model_capabilities:/)
  assert.match(preview, /m: 图像✓ 视频✗ 工具✓/)
})
