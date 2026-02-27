import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parseEnvOverlay } from "../src/config/load-config.mjs"

describe("parseEnvOverlay", () => {
  it("parses simple top-level key", () => {
    const result = parseEnvOverlay("KKCODE_LANGUAGE=zh\n")
    assert.deepEqual(result, { language: "zh" })
  })

  it("parses nested keys with __ separator", () => {
    const result = parseEnvOverlay("KKCODE_PROVIDER__DEFAULT=anthropic\n")
    assert.deepEqual(result, { provider: { default: "anthropic" } })
  })

  it("preserves single underscores in key names", () => {
    const result = parseEnvOverlay("KKCODE_AGENT__DEFAULT_MODE=longagent\n")
    assert.deepEqual(result, { agent: { default_mode: "longagent" } })
  })

  it("handles deep nesting", () => {
    const result = parseEnvOverlay("KKCODE_AGENT__LONGAGENT__PARALLEL__MAX_CONCURRENCY=5\n")
    assert.deepEqual(result, { agent: { longagent: { parallel: { max_concurrency: 5 } } } })
  })

  it("coerces true/false to boolean", () => {
    const result = parseEnvOverlay("KKCODE_AGENT__LONGAGENT__HYBRID__ENABLED=true\nKKCODE_MCP__AUTO_DISCOVER=false\n")
    assert.equal(result.agent.longagent.hybrid.enabled, true)
    assert.equal(result.mcp.auto_discover, false)
  })

  it("coerces numeric strings to numbers", () => {
    const result = parseEnvOverlay("KKCODE_AGENT__MAX_STEPS=12\n")
    assert.equal(result.agent.max_steps, 12)
    assert.equal(typeof result.agent.max_steps, "number")
  })

  it("strips double quotes from values", () => {
    const result = parseEnvOverlay('KKCODE_LANGUAGE="en"\n')
    assert.equal(result.language, "en")
  })

  it("strips single quotes from values", () => {
    const result = parseEnvOverlay("KKCODE_LANGUAGE='zh'\n")
    assert.equal(result.language, "zh")
  })

  it("ignores comment lines", () => {
    const result = parseEnvOverlay("# this is a comment\nKKCODE_LANGUAGE=en\n# another\n")
    assert.deepEqual(result, { language: "en" })
  })

  it("ignores non-KKCODE_ vars", () => {
    const result = parseEnvOverlay("PATH=/usr/bin\nHOME=/root\nKKCODE_LANGUAGE=en\n")
    assert.deepEqual(result, { language: "en" })
  })

  it("ignores empty lines and blank values", () => {
    const result = parseEnvOverlay("\n\nKKCODE_LANGUAGE=\n\n")
    // empty string stays as empty string (not coerced)
    assert.equal(result.language, "")
  })

  it("returns empty object for no KKCODE_ vars", () => {
    assert.deepEqual(parseEnvOverlay("FOO=bar\n"), {})
    assert.deepEqual(parseEnvOverlay(""), {})
  })
})
