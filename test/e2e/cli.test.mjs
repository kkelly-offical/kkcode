import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { resolve, join } from "node:path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"

const CLI = resolve("src/index.mjs")
const NODE = process.execPath

function run(args, { timeout = 15000, env = {}, expectFail = false } = {}) {
  try {
    const stdout = execFileSync(NODE, [CLI, ...args], {
      encoding: "utf8",
      timeout,
      env: { ...process.env, ...env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    })
    if (expectFail) throw new Error("expected non-zero exit but got 0")
    return { stdout, exitCode: 0 }
  } catch (err) {
    if (!expectFail) throw err
    return { stdout: err.stdout || "", stderr: err.stderr || "", exitCode: err.status || 1 }
  }
}

// --help
test("e2e: --help exits 0 and lists commands", () => {
  const { stdout } = run(["--help"])
  assert.ok(stdout.includes("chat"), "should list chat command")
  assert.ok(stdout.includes("doctor"), "should list doctor command")
  assert.ok(stdout.includes("session"), "should list session command")
})

// --version
test("e2e: --version exits 0", () => {
  const { stdout } = run(["--version"])
  assert.ok(stdout.trim().length > 0, "should output version")
})

// doctor
test("e2e: doctor exits 0", () => {
  const { stdout } = run(["doctor"])
  assert.ok(stdout.includes("node"), "should check node")
})

test("e2e: doctor --json exits 0 and outputs structured json", () => {
  const home = mkdtempSync(join(tmpdir(), "kkcode-e2e-doctor-"))
  try {
    const { stdout } = run(["doctor", "--json"], { env: { KKCODE_HOME: home } })
    const parsed = JSON.parse(stdout)
    assert.equal(typeof parsed.ok, "boolean")
    assert.ok(parsed.config)
    assert.ok(parsed.storage)
    assert.ok(parsed.background)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// theme preview
test("e2e: theme preview exits 0", () => {
  const { stdout } = run(["theme", "preview"])
  assert.ok(stdout.length > 0, "should output theme preview")
})

// usage show
test("e2e: usage show exits 0", () => {
  const { stdout } = run(["usage", "show"])
  assert.ok(stdout.includes("global"), "should show global usage")
})

// session list
test("e2e: session list exits 0", () => {
  run(["session", "list"])
})

test("e2e: session fsck exits 0 on clean home", () => {
  const home = mkdtempSync(join(tmpdir(), "kkcode-e2e-fsck-"))
  try {
    const { stdout } = run(["session", "fsck", "--json"], { env: { KKCODE_HOME: home } })
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.ok, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// agent list
test("e2e: agent list exits 0", () => {
  run(["agent", "list"])
})

// mcp list
test("e2e: mcp list exits 0", () => {
  run(["mcp", "list"])
})

// permission show
test("e2e: permission show exits 0 and shows policy", () => {
  const { stdout } = run(["permission", "show"])
  assert.ok(stdout.includes("default_policy"), "should show default_policy")
})

// prompt list
test("e2e: prompt list exits 0", () => {
  const { stdout } = run(["prompt", "list"])
  assert.ok(stdout.includes("prompt"), "should list prompt dirs")
})

// hook list
test("e2e: hook list exits 0", () => {
  const { stdout } = run(["hook", "list"])
  assert.ok(stdout.includes("supported events"), "should list supported events")
})

// command list
test("e2e: command list exits 0", () => {
  run(["command", "list"])
})

// rule list
test("e2e: rule list exits 0", () => {
  run(["rule", "list"])
})

test("e2e: longagent stop requires --force", () => {
  const { exitCode } = run(["longagent", "stop", "--session", "fake"], { expectFail: true })
  assert.ok(exitCode !== 0, "should fail without --force")
})

// background list
test("e2e: background list exits 0", () => {
  run(["background", "list"])
})

test("e2e: background retry on missing task exits non-zero", () => {
  const { exitCode } = run(["background", "retry", "--id", "bg_missing"], { expectFail: true })
  assert.ok(exitCode !== 0, "should fail for missing task")
})

test("e2e: audit list --json exits 0", () => {
  const { stdout } = run(["audit", "list", "--json"])
  const parsed = JSON.parse(stdout)
  assert.ok(Array.isArray(parsed), "should return array")
})

// config import error path
test("e2e: config import with bad file exits non-zero", () => {
  const { exitCode } = run(["config", "import", "--from", "nonexistent_file.yaml", "--to", "nonexistent_target.yaml"], { expectFail: true })
  assert.ok(exitCode !== 0, "should fail with bad file")
})

// chat without API key
test("e2e: chat without API key exits non-zero", () => {
  const { exitCode } = run(["chat", "hello"], {
    expectFail: true,
    env: { OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" }
  })
  assert.ok(exitCode !== 0, "should fail without API key")
})

// unknown command
test("e2e: unknown command exits non-zero", () => {
  const { exitCode } = run(["nonexistent_command_xyz"], { expectFail: true })
  assert.ok(exitCode !== 0, "should fail for unknown command")
})
