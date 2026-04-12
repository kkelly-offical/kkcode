import test from "node:test"
import assert from "node:assert/strict"
import { executePromptTurn } from "../src/repl/turn-controller.mjs"

test("executePromptTurn forwards text-only turns without content blocks", async () => {
  let received = null
  const turn = await executePromptTurn({
    prompt: "hello",
    state: { mode: "agent", model: "gpt-5", providerType: "openai", sessionId: "sid_1" },
    ctx: { configState: { config: {} } },
    deps: {
      cwd: "/tmp/repo",
      extractImageRefs: () => ({ text: "hello", imagePaths: [], imageUrls: [] }),
      chatParams: async (params) => params,
      executeTurn: async (params) => {
        received = params
        return { reply: "ok" }
      }
    }
  })
  assert.deepEqual(turn, { result: { reply: "ok" } })
  assert.equal(received.prompt, "hello")
  assert.equal(received.contentBlocks, null)
  assert.equal(received.output, null)
})

test("executePromptTurn builds content blocks and appends pending images", async () => {
  let received = null
  await executePromptTurn({
    prompt: "see image",
    state: { mode: "agent", model: "gpt-5", providerType: "openai", sessionId: "sid_2" },
    ctx: { configState: { config: {} } },
    pendingImages: [{ type: "image", source: { type: "base64", data: "abc", media_type: "image/png" } }],
    deps: {
      cwd: "/tmp/repo",
      extractImageRefs: () => ({ text: "see image", imagePaths: ["a.png"], imageUrls: [] }),
      buildContentBlocks: async () => [{ type: "text", text: "see image" }],
      chatParams: async (params) => params,
      executeTurn: async (params) => {
        received = params
        return { reply: "ok" }
      }
    }
  })
  assert.equal(received.contentBlocks.length, 2)
  assert.equal(received.contentBlocks[0].type, "text")
  assert.equal(received.contentBlocks[1].type, "image")
})

test("executePromptTurn applies chat param overrides and stream sink", async () => {
  let received = null
  const writes = []
  await executePromptTurn({
    prompt: "hello",
    state: { mode: "agent", model: "gpt-5", providerType: "openai", sessionId: "sid_3" },
    ctx: { configState: { config: {} } },
    streamSink(chunk) {
      writes.push(chunk)
    },
    deps: {
      cwd: "/tmp/repo",
      extractImageRefs: () => ({ text: "hello", imagePaths: [], imageUrls: [] }),
      chatParams: async () => ({
        prompt: "hello rewritten",
        mode: "ask",
        model: "gpt-5-mini",
        providerType: "anthropic"
      }),
      executeTurn: async (params) => {
        received = params
        params.output.write("streamed")
        return { reply: "ok" }
      }
    }
  })
  assert.equal(received.prompt, "hello rewritten")
  assert.equal(received.mode, "ask")
  assert.equal(received.model, "gpt-5-mini")
  assert.equal(received.providerType, "anthropic")
  assert.deepEqual(writes, ["streamed"])
})
