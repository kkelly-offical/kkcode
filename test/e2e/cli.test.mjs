import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { resolve, join } from "node:path"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

const CLI = resolve("src/index.mjs")
const NODE = process.execPath

function createIsolatedHome(prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(home, "config.json"), JSON.stringify({
    mcp: {
      auto_discover: false,
      servers: {}
    },
    skills: { auto_seed: false }
  }), "utf8")
  return home
}

function run(args, { timeout = 15000, env = {}, expectFail = false, cwd } = {}) {
  try {
    const stdout = execFileSync(NODE, [CLI, ...args], {
      encoding: "utf8",
      timeout,
      env: { ...process.env, ...env, NO_COLOR: "1" },
      cwd,
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
  const home = createIsolatedHome("kkcode-e2e-doctor-text-")
  try {
    const { stdout } = run(["doctor"], { env: { KKCODE_HOME: home } })
    assert.ok(stdout.includes("node"), "should check node")
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test("e2e: doctor --json exits 0 and outputs structured json", () => {
  const home = createIsolatedHome("kkcode-e2e-doctor-")
  try {
    const { stdout } = run(["doctor", "--json"], { env: { KKCODE_HOME: home } })
    const parsed = JSON.parse(stdout)
    assert.equal(typeof parsed.ok, "boolean")
    assert.ok(parsed.config)
    assert.ok(parsed.storage)
    assert.ok(parsed.background)
    assert.ok(!parsed.runtime.providersConfigured.some((provider) => provider.name === "model_context"))
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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

test("e2e: update --help exits 0", () => {
  const { stdout } = run(["update", "--help"])
  assert.ok(stdout.includes("check for and install kkcode updates"), "should describe updater")
})

// session list
test("e2e: session list exits 0", () => {
  run(["session", "list"])
})

test("e2e: session status exits 0", () => {
  run(["session", "status"])
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
  const home = createIsolatedHome("kkcode-e2e-mcp-")
  try {
    run(["mcp", "list"], { env: { KKCODE_HOME: home } })
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test("e2e: mcp init does not preload Context7", () => {
  const home = createIsolatedHome("kkcode-e2e-mcp-init-home-")
  const project = mkdtempSync(join(tmpdir(), "kkcode-e2e-mcp-init-project-"))
  try {
    run(["mcp", "init", "--project"], {
      cwd: project,
      env: { KKCODE_HOME: home }
    })
    const initialized = JSON.parse(readFileSync(join(project, ".kkcode", "mcp.json"), "utf8"))
    assert.deepEqual(initialized, { servers: {} })
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

// permission show
test("e2e: permission show exits 0 and shows policy", () => {
  const { stdout } = run(["permission", "show"])
  // 0.4.0: permission.level is the only approval switch. default_policy and
  // mode were dropped from DEFAULT_CONFIG, so a clean environment no longer
  // prints them — this used to pass only because a stale user config supplied
  // default_policy locally.
  assert.ok(stdout.includes("level"), "should show permission.level")
  assert.ok(stdout.includes("non_tty_default"), "should show non_tty_default")
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

test("e2e: background output on missing task exits non-zero", () => {
  const { exitCode } = run(["background", "output", "--id", "bg_missing"], { expectFail: true })
  assert.ok(exitCode !== 0, "should fail for missing task output")
})

test("e2e: background wait on missing task exits non-zero", () => {
  const { exitCode } = run(["background", "wait", "--id", "bg_missing", "--timeout", "1"], { expectFail: true })
  assert.ok(exitCode !== 0, "should fail for missing task wait")
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
  const home = createIsolatedHome("kkcode-e2e-chat-")
  try {
    const { exitCode } = run(["chat", "hello"], {
      expectFail: true,
      env: {
        KKCODE_HOME: home,
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: ""
      }
    })
    assert.ok(exitCode !== 0, "should fail without API key")
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

// unknown command
test("e2e: unknown command exits non-zero", () => {
  const { exitCode } = run(["nonexistent_command_xyz"], { expectFail: true })
  assert.ok(exitCode !== 0, "should fail for unknown command")
})
