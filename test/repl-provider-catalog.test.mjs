import test from "node:test"
import assert from "node:assert/strict"
import { mediaSupportFromCapabilities } from "../src/repl/provider-catalog.mjs"

/**
 * 能力标记 → 附件门的三级决断（1.0.1）。
 * 能力标记本身来自 M33 的 resolveModelCapabilities（配置 > 探测缓存 > 启发式，
 * 内核侧有测试）；这里钉的是 UI 侧「确知值 → true/false，未知 → image 放行、
 * 其余按未知」的映射纪律。
 */

test("known capability flags pass through in both directions", () => {
  const caps = { image: true, video: false }
  assert.equal(mediaSupportFromCapabilities(caps, "image"), true)
  assert.equal(mediaSupportFromCapabilities(caps, "video"), false)
})

test("unknown kinds degrade honestly: image allowed, video/audio unknown", () => {
  assert.equal(mediaSupportFromCapabilities({}, "image"), true)
  assert.equal(mediaSupportFromCapabilities({}, "video"), null)
  assert.equal(mediaSupportFromCapabilities({}, "audio"), null)
  assert.equal(mediaSupportFromCapabilities(null, "video"), null)
  assert.equal(mediaSupportFromCapabilities(undefined, "image"), true)
})

test("an explicit false for image overrides the default allow", () => {
  assert.equal(mediaSupportFromCapabilities({ image: false }, "image"), false)
})
