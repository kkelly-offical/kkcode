import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { executePromptTurn } from "../src/repl/turn-controller.mjs"
import { saveGhostCommit } from "../src/storage/ghost-commit-store.mjs"
import { setQuestionPromptHandler } from "../src/tool/question-prompt.mjs"

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
        mode: "assistant",
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
  assert.equal(received.mode, "assistant")
  assert.equal(received.model, "gpt-5-mini")
  assert.equal(received.providerType, "anthropic")
  assert.deepEqual(writes, ["streamed"])
})

test("executePromptTurn handles natural-language undo before the provider and selects the foreground session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kkcode-repl-undo-"))
  const repoDir = path.join(root, "repo")
  const previousHome = process.env.KKCODE_HOME
  let providerCalled = false
  let promptDescription = ""

  try {
    process.env.KKCODE_HOME = path.join(root, "state")
    execFileSync("git", ["init", repoDir], { stdio: "ignore" })

    const now = Date.now()
    await saveGhostCommit({
      id: "foreground-a",
      commitHash: "aaaaaaaa11111111",
      repoPath: repoDir,
      parentHash: "parent",
      sessionId: "sessA",
      message: "Auto snapshot before AI edit (session: sessA)",
      createdAt: now - 1000,
      files: ["a.mjs"]
    })
    await saveGhostCommit({
      id: "newer-other-session",
      commitHash: "bbbbbbbb22222222",
      repoPath: repoDir,
      parentHash: "parent",
      sessionId: "sessB",
      message: "Auto snapshot before AI edit (session: sessB)",
      createdAt: now,
      files: ["b.mjs"]
    })

    setQuestionPromptHandler(({ questions }) => {
      promptDescription = String(questions[0]?.description || "")
      return { rollback_confirm: "no" }
    })

    const turn = await executePromptTurn({
      prompt: "undo last change",
      state: { mode: "agent", model: "gpt-5", providerType: "openai", sessionId: "sessA" },
      ctx: { configState: { config: { language: "en" } } },
      deps: {
        cwd: repoDir,
        extractImageRefs: () => ({ text: "undo last change", imagePaths: [], imageUrls: [] }),
        chatParams: async () => {
          throw new Error("chat hooks must not run for a handled rollback")
        },
        executeTurn: async () => {
          providerCalled = true
          throw new Error("provider must not run for a handled rollback")
        }
      }
    })

    assert.equal(turn.result.reply, "Rollback cancelled.")
    assert.equal(turn.result.emittedText, false)
    assert.equal(providerCalled, false)
    assert.match(promptDescription, /aaaaaaaa/,
      "the real foreground entry must offer the current session's snapshot")
    assert.doesNotMatch(promptDescription, /bbbbbbbb/,
      "a newer snapshot from another session must not leak into the prompt")
  } finally {
    setQuestionPromptHandler(null)
    if (previousHome === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

test("executePromptTurn sends rollback discussions to the provider instead of opening undo", async () => {
  const providerPrompts = []
  const discussionPrompts = ["How does git rollback work?", "解释 rollback 的实现"]

  for (const prompt of discussionPrompts) {
    const turn = await executePromptTurn({
      prompt,
      state: { mode: "agent", model: "gpt-5", providerType: "openai", sessionId: "discussion-session" },
      ctx: { configState: { config: { language: "zh" } } },
      deps: {
        cwd: "/tmp/repo",
        extractImageRefs: (text) => ({ text, imagePaths: [], imageUrls: [] }),
        chatParams: async (params) => params,
        executeTurn: async (params) => {
          providerPrompts.push(params.prompt)
          return { reply: "model explanation" }
        }
      }
    })
    assert.equal(turn.result.reply, "model explanation")
  }

  assert.deepEqual(providerPrompts, discussionPrompts,
    "discussion prompts must pass through the real foreground entry unchanged")
})
