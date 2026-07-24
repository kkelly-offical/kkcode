import test from "node:test"
import assert from "node:assert/strict"
import { refineSessionTitle, normalizeTitle } from "../src/session/session-title.mjs"

function makeConfigState(fast = "gpt-tiny") {
  return {
    config: {
      provider: { default: "openai", openai: { default_model: "gpt-main" } },
      models: fast ? { fast } : {}
    }
  }
}

test("titles are single-line, unquoted and length-capped", () => {
  assert.equal(normalizeTitle("Fix the login redirect"), "Fix the login redirect")
  assert.equal(normalizeTitle('"Quoted title"'), "Quoted title")
  assert.equal(normalizeTitle("「中文标题」"), "中文标题")
  assert.equal(normalizeTitle("first line\nsecond line"), "first line")
  assert.equal(normalizeTitle("  \n  spaced  out  \n"), "spaced out")
  assert.equal(normalizeTitle(""), "")
  assert.equal(normalizeTitle("x".repeat(80)).length, 50)
})

test("terminal control sequences never reach the session title", () => {
  const title = normalizeTitle("safe[31mred[0m")
  assert.ok(!title.includes(""), `escaped sequence leaked: ${JSON.stringify(title)}`)
})

test("nothing happens without a fast model configured", async () => {
  let called = false
  const out = await refineSessionTitle({
    configState: makeConfigState(null),
    sessionId: "s1",
    prompt: "add a login page",
    deps: {
      requestFast: async () => { called = true; return "Login page" },
      getSession: async () => ({ title: "add a login page" }),
      updateSession: async () => {}
    }
  })
  assert.equal(out, null)
  assert.equal(called, false)
})

test("a generated title replaces the truncated auto title", async () => {
  const writes = []
  const out = await refineSessionTitle({
    configState: makeConfigState(),
    sessionId: "s1",
    prompt: "add a login page with oauth",
    autoTitle: "add a login page with oauth",
    deps: {
      systemPrompt: "generate a title",
      requestFast: async () => "OAuth login page",
      getSession: async () => ({ title: "add a login page with oauth" }),
      updateSession: async (id, patch) => writes.push([id, patch])
    }
  })

  assert.equal(out, "OAuth login page")
  assert.deepEqual(writes, [["s1", { title: "OAuth login page" }]])
})

test("a user-edited title is never overwritten", async () => {
  const writes = []
  const out = await refineSessionTitle({
    configState: makeConfigState(),
    sessionId: "s1",
    prompt: "add a login page",
    autoTitle: "add a login page",
    deps: {
      systemPrompt: "generate a title",
      requestFast: async () => "Something else",
      getSession: async () => ({ title: "My own title" }),
      updateSession: async (id, patch) => writes.push([id, patch])
    }
  })

  assert.equal(out, null)
  assert.deepEqual(writes, [])
})

test("failures stay silent and write nothing", async () => {
  const writes = []
  const out = await refineSessionTitle({
    configState: makeConfigState(),
    sessionId: "s1",
    prompt: "hello",
    deps: {
      systemPrompt: "generate a title",
      requestFast: async () => { throw new Error("provider down") },
      getSession: async () => ({ title: "hello" }),
      updateSession: async (id, patch) => writes.push([id, patch])
    }
  })
  assert.equal(out, null)
  assert.deepEqual(writes, [])
})

test("an empty model reply leaves the existing title alone", async () => {
  const writes = []
  const out = await refineSessionTitle({
    configState: makeConfigState(),
    sessionId: "s1",
    prompt: "hello",
    deps: {
      systemPrompt: "generate a title",
      requestFast: async () => "   ",
      getSession: async () => ({ title: "hello" }),
      updateSession: async (id, patch) => writes.push([id, patch])
    }
  })
  assert.equal(out, null)
  assert.deepEqual(writes, [])
})
