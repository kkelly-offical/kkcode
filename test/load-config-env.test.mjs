import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { writeFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

// We test parseEnvOverlay indirectly via loadConfig, but first let's
// extract and test the parser logic directly by importing the module.
// Since parseEnvOverlay is not exported, we test through loadConfig integration.

const tmpDir = path.join(os.tmpdir(), `kkcode-env-test-${Date.now()}`)

describe("loadConfig .env overlay", () => {
  let isolatedHome
  let previousKkcodeHome

  beforeEach(async () => {
    await mkdir(tmpDir, { recursive: true })
    isolatedHome = await mkdtemp(path.join(os.tmpdir(), "kkcode-env-home-"))
    previousKkcodeHome = process.env.KKCODE_HOME
    process.env.KKCODE_HOME = isolatedHome
  })

  afterEach(async () => {
    if (previousKkcodeHome === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previousKkcodeHome
    await rm(tmpDir, { recursive: true, force: true })
    await rm(isolatedHome, { recursive: true, force: true })
  })

  it("loads KKCODE_ prefixed vars from .env", async () => {
    const envContent = [
      "# comment line",
      "KKCODE_PROVIDER__DEFAULT=anthropic",
      "KKCODE_AGENT__DEFAULT_MODE=longagent",
      "OTHER_VAR=ignored",
      ""
    ].join("\n")
    await writeFile(path.join(tmpDir, ".env"), envContent)

    // Use dynamic import to get loadConfig
    const { loadConfig } = await import("../src/config/load-config.mjs")
    const result = await loadConfig(tmpDir)

    assert.equal(result.config.provider.default, "anthropic")
    assert.equal(result.config.agent.default_mode, "longagent")
  })

  it("coerces boolean and number types", async () => {
    const envContent = [
      "KKCODE_AGENT__LONGAGENT__PARALLEL__ENABLED=true",
      "KKCODE_AGENT__LONGAGENT__PARALLEL__MAX_CONCURRENCY=8",
      "KKCODE_AGENT__LONGAGENT__HYBRID__CROSS_REVIEW=false",
      ""
    ].join("\n")
    await writeFile(path.join(tmpDir, ".env"), envContent)

    const { loadConfig } = await import("../src/config/load-config.mjs")
    const result = await loadConfig(tmpDir)

    assert.equal(result.config.agent.longagent.parallel.enabled, true)
    assert.equal(result.config.agent.longagent.parallel.max_concurrency, 8)
    assert.equal(result.config.agent.longagent.hybrid.cross_review, false)
  })

  it("strips surrounding quotes from values", async () => {
    const envContent = [
      'KKCODE_LANGUAGE="zh"',
      "KKCODE_UI_LAYOUT='compact'",
      ""
    ].join("\n")
    await writeFile(path.join(tmpDir, ".env"), envContent)

    const { loadConfig } = await import("../src/config/load-config.mjs")
    const result = await loadConfig(tmpDir)

    assert.equal(result.config.language, "zh")
    assert.equal(result.config.ui.layout, "compact")
  })

  it("reports envPath in source when .env has KKCODE_ vars", async () => {
    await writeFile(path.join(tmpDir, ".env"), "KKCODE_LANGUAGE=zh\n")

    const { loadConfig } = await import("../src/config/load-config.mjs")
    const result = await loadConfig(tmpDir)

    assert.equal(result.source.envPath, path.join(tmpDir, ".env"))
    assert.equal(result.source.envScope, "project")
    assert.ok(result.source.envOverlay.language !== undefined)
    assert.equal(result.config.language, "zh")
    assert.equal(result.userConfig.language, "en")
  })

  it("attributes the user-level .env overlay to userConfig", async () => {
    await writeFile(path.join(isolatedHome, ".env"), "KKCODE_LANGUAGE=zh\n")
    const { loadConfig } = await import("../src/config/load-config.mjs")
    const result = await loadConfig(tmpDir)

    assert.equal(result.source.envScope, "user")
    assert.equal(result.config.language, "zh")
    assert.equal(result.userConfig.language, "zh")
  })

  it("envPath is null when no .env or no KKCODE_ vars", async () => {
    // No .env file at all
    const { loadConfig } = await import("../src/config/load-config.mjs")
    const result = await loadConfig(tmpDir)

    assert.equal(result.source.envPath, null)
  })
})
