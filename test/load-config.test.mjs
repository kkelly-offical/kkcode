import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { loadConfig } from "../src/config/load-config.mjs"

let tmpDir

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "cfg-test-"))
  process.env.KKCODE_HOME = tmpDir
})

afterEach(async () => {
  delete process.env.KKCODE_HOME
  await rm(tmpDir, { recursive: true, force: true })
})

describe("loadConfig", () => {
  it("returns default config when no files exist", async () => {
    const result = await loadConfig(tmpDir)
    assert.ok(result.config)
    assert.ok(result.config.provider)
    assert.ok(result.config.agent)
    assert.deepEqual(result.errors, [])
  })

  it("loads project YAML config", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.yaml"), `
provider:
  default: openai
`)
    const result = await loadConfig(tmpDir)
    assert.equal(result.config.provider.default, "openai")
    assert.ok(result.source.projectPath)
  })

  it("loads project JSON config", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.json"), JSON.stringify({
      provider: { default: "anthropic" }
    }))
    const result = await loadConfig(tmpDir)
    assert.equal(result.config.provider.default, "anthropic")
  })

  it("reports errors for invalid YAML", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.yaml"), "{{invalid yaml")
    const result = await loadConfig(tmpDir)
    assert.ok(result.errors.length > 0)
  })

  it("merges project config over defaults", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.yaml"), `
agent:
  max_steps: 99
`)
    const result = await loadConfig(tmpDir)
    assert.equal(result.config.agent.max_steps, 99)
    // Other defaults should still be present
    assert.ok(result.config.provider)
  })

  it("source includes paths and raw config", async () => {
    const result = await loadConfig(tmpDir)
    assert.equal(result.source.projectPath, null)
    assert.equal(result.source.userPath, null)
  })
})
