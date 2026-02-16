import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import YAML from "yaml"
import { validateConfig } from "../src/config/schema.mjs"

async function runInit(cwd, args = []) {
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const exec = promisify(execFile)
  return exec(process.execPath, [join(import.meta.dirname, "..", "src", "index.mjs"), "init", ...args], { cwd, timeout: 10000 })
}

let tmpDir
before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kkcode-test-init-"))
})
after(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

test("init --yes creates valid config.yaml", async () => {
  const dir = join(tmpDir, "fresh")
  await mkdir(dir, { recursive: true })
  const { stdout } = await runInit(dir, ["--yes"])
  assert.ok(stdout.includes("created:"))

  const content = await readFile(join(dir, ".kkcode", "config.yaml"), "utf8")
  const config = YAML.parse(content)
  assert.equal(config.provider.default, "openai")
  assert.equal(config.permission.default_policy, "ask")

  const check = validateConfig(config)
  assert.ok(check.valid, `config invalid: ${check.errors.join(", ")}`)
})

test("init --yes does not overwrite existing config", async () => {
  const dir = join(tmpDir, "existing")
  const configDir = join(dir, ".kkcode")
  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, "config.yaml"), "provider:\n  default: anthropic\n", "utf8")

  const { stdout } = await runInit(dir, ["--yes"])
  assert.ok(stdout.includes("already exists"))

  const content = await readFile(join(configDir, "config.yaml"), "utf8")
  assert.ok(content.includes("anthropic"))
})

test("init --yes generated config has correct provider defaults", async () => {
  const dir = join(tmpDir, "defaults")
  await mkdir(dir, { recursive: true })
  await runInit(dir, ["--yes"])

  const content = await readFile(join(dir, ".kkcode", "config.yaml"), "utf8")
  const config = YAML.parse(content)
  const openaiBlock = config.provider.openai
  assert.ok(openaiBlock)
  assert.equal(openaiBlock.api_key_env, "OPENAI_API_KEY")
  assert.equal(openaiBlock.default_model, "gpt-5.3-codex")
})
