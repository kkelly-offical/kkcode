import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  configuredProviders,
  loadHistoryLines,
  saveHistoryLines,
  resolveProviderDefaultModel,
  createInitialReplState,
  collectMcpStatusLines
} from "../src/repl/core-shell.mjs"

test("configuredProviders filters configured builtin providers", () => {
  const config = {
    provider: {
      default: "openai",
      strict_mode: true,
      model_context: {},
      openai: { type: "openai" },
      anthropic: { type: "anthropic" },
      local: { type: "custom-local" },
      broken: null
    }
  }
  const result = configuredProviders(config, () => ["openai", "anthropic"])
  assert.deepEqual(result, ["openai", "anthropic"])
})

test("resolveProviderDefaultModel prefers explicit provider default", () => {
  const config = {
    provider: {
      default: "openai",
      openai: { default_model: "gpt-5" },
      anthropic: { default_model: "claude-x" }
    }
  }
  assert.equal(resolveProviderDefaultModel(config, "anthropic"), "claude-x")
  assert.equal(resolveProviderDefaultModel(config, "unknown"), "gpt-5")
})

test("createInitialReplState derives session, mode, provider and model", () => {
  const config = {
    agent: { default_mode: "plan" },
    provider: {
      default: "openai",
      openai: { default_model: "gpt-5" }
    }
  }
  const state = createInitialReplState(config, { newSessionIdFn: () => "sid_123" })
  assert.deepEqual(state, {
    sessionId: "sid_123",
    mode: "plan",
    providerType: "openai",
    model: "gpt-5"
  })
})

test("collectMcpStatusLines renders healthy and unhealthy lines", () => {
  const theme = {
    semantic: { success: "green", error: "red" },
    base: { muted: "gray" }
  }
  const lines = collectMcpStatusLines(
    theme,
    [
      { name: "alpha", ok: true, transport: "stdio" },
      { name: "beta", ok: false, reason: "timeout" }
    ],
    [{ server: "alpha" }, { server: "alpha" }]
  )
  assert.equal(lines.length, 2)
  assert.match(lines[0], /alpha/)
  assert.match(lines[0], /2 tools/)
  assert.match(lines[1], /beta/)
  assert.match(lines[1], /timeout/)
})

test("saveHistoryLines and loadHistoryLines round-trip trimmed history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kkcode-core-shell-"))
  const file = join(dir, "history")
  try {
    await saveHistoryLines(file, 3, ["a", "b", "c", "d"])
    const loaded = await loadHistoryLines(file, 3)
    assert.deepEqual(loaded, ["b", "c", "d"])
    const raw = await readFile(file, "utf8")
    assert.match(raw, /b\nc\nd\n$/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
