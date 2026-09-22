import test from "node:test"
import assert from "node:assert/strict"
import { modelMediaSupport } from "../src/repl/provider-catalog.mjs"

/**
 * 模型媒体能力面的三级判据（1.0.1）：
 * 显式配置/探测回填（同一键）> 缺省（image 支持、video/audio 未知）。
 * 粘贴视频/语音时 UI 据此决定「放行 / 明确拒绝 / 挂标记但警告」。
 */

test("an explicit capability flag wins, in both directions", () => {
  const config = {
    provider: {
      model_media_capabilities: {
        "vision-model": { image: true, video: true },
        "text-only": { image: false, video: false, audio: false }
      }
    }
  }
  assert.equal(modelMediaSupport({ config, model: "vision-model", kind: "video" }), true)
  assert.equal(modelMediaSupport({ config, model: "text-only", kind: "image" }), false,
    "显式 false 也要压住 image 的缺省 true")
})

test("defaults: image is allowed, video and audio are unknown", () => {
  const config = { provider: {} }
  assert.equal(modelMediaSupport({ config, model: "anything", kind: "image" }), true)
  assert.equal(modelMediaSupport({ config, model: "anything", kind: "video" }), null)
  assert.equal(modelMediaSupport({ config, model: "anything", kind: "audio" }), null)
})

test("missing config pieces never throw", () => {
  assert.equal(modelMediaSupport({ config: null, model: "m", kind: "image" }), true)
  assert.equal(modelMediaSupport({ config: undefined, model: "", kind: "video" }), null)
  assert.equal(modelMediaSupport({ config: { provider: { model_media_capabilities: { m: {} } } }, model: "m", kind: "audio" }), null)
})
