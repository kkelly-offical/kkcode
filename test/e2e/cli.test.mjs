import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { resolve, join } from "node:path"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"

const CLI = resolve("src/index.mjs")
const NODE = process.execPath

function run(args, { timeout = 15000, env = {}, cwd = process.cwd(), expectFail = false } = {}) {
  try {
    const stdout = execFileSync(NODE, [CLI, ...args], {
      encoding: "utf8",
      timeout,
      cwd,
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

test("e2e: session picker --json exits 0 on clean home", () => {
  const home = mkdtempSync(join(tmpdir(), "kkcode-e2e-picker-"))
  try {
    const { stdout } = run(["session", "picker", "--json"], {
      env: { KKCODE_HOME: home }
    })
    assert.ok(stdout.includes("no recoverable sessions"))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("e2e: init --providers prints provider guidance", () => {
  const { stdout } = run(["init", "--providers"])
  assert.ok(stdout.includes("providers:"))
  assert.ok(stdout.includes("auth:"))
})

test("e2e: auth verify reports ready env-backed provider", () => {
  const dir = mkdtempSync(join(tmpdir(), "kkcode-e2e-auth-verify-"))
  try {
    run(["init", "--yes"], {
      cwd: dir,
      env: { OPENAI_API_KEY: "test-key" }
    })
    const { stdout } = run(["auth", "verify", "openai"], {
      cwd: dir,
      env: { OPENAI_API_KEY: "test-key" }
    })
    assert.ok(stdout.includes("verified: ready"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("e2e: auth onboard sets default provider and verifies ready env-backed provider", () => {
  const dir = mkdtempSync(join(tmpdir(), "kkcode-e2e-auth-onboard-"))
  try {
    run(["init", "--yes"], {
      cwd: dir,
      env: { OPENAI_API_KEY: "test-key" }
    })
    const { stdout } = run(["auth", "onboard", "openai", "--no-login"], {
      cwd: dir,
      env: { OPENAI_API_KEY: "test-key" }
    })
    assert.ok(stdout.includes("set_default:"))
    assert.ok(stdout.includes("verified: ready"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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

test("e2e: longagent task shows linked background task", () => {
  const home = mkdtempSync(join(tmpdir(), "kkcode-e2e-longagent-home-"))
  const project = mkdtempSync(join(tmpdir(), "kkcode-e2e-longagent-project-"))
  try {
    mkdirSync(join(project, ".kkcode"), { recursive: true })
    mkdirSync(join(home, "tasks"), { recursive: true })
    writeFileSync(join(project, ".kkcode", "longagent-state.json"), JSON.stringify({
      sessions: {
        ses_demo: {
          sessionId: "ses_demo",
          status: "running",
          phase: "H4",
          objective: "demo",
          backgroundTaskId: "bg_demo",
          backgroundTaskStatus: "running",
          backgroundTaskAttempt: 1,
          backgroundTaskUpdatedAt: 1234567890,
          createdAt: 1,
          updatedAt: 1
        }
      }
    }, null, 2))
    writeFileSync(join(home, "tasks", "bg_demo.json"), JSON.stringify({
      id: "bg_demo",
      status: "running",
      attempt: 1,
      updatedAt: 1234567890
    }, null, 2))
    const { stdout } = run(["longagent", "task", "--session", "ses_demo"], {
      cwd: project,
      env: { KKCODE_HOME: home }
    })
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.id, "bg_demo")
    assert.equal(parsed.status, "running")
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test("e2e: longagent cancel-task cancels linked background task", () => {
  const home = mkdtempSync(join(tmpdir(), "kkcode-e2e-longagent-cancel-home-"))
  const project = mkdtempSync(join(tmpdir(), "kkcode-e2e-longagent-cancel-project-"))
  try {
    mkdirSync(join(project, ".kkcode"), { recursive: true })
    mkdirSync(join(home, "tasks"), { recursive: true })
    writeFileSync(join(project, ".kkcode", "longagent-state.json"), JSON.stringify({
      sessions: {
        ses_demo: {
          sessionId: "ses_demo",
          status: "running",
          phase: "H4",
          objective: "demo",
          backgroundTaskId: "bg_demo",
          backgroundTaskStatus: "running",
          backgroundTaskAttempt: 1,
          backgroundTaskUpdatedAt: 1234567890,
          createdAt: 1,
          updatedAt: 1
        }
      }
    }, null, 2))
    writeFileSync(join(home, "tasks", "bg_demo.json"), JSON.stringify({
      id: "bg_demo",
      status: "running",
      attempt: 1,
      updatedAt: 1234567890,
      cancelled: false
    }, null, 2))
    const { stdout } = run(["longagent", "cancel-task", "--session", "ses_demo"], {
      cwd: project,
      env: { KKCODE_HOME: home }
    })
    assert.ok(stdout.includes("background cancel requested"))
    const task = JSON.parse(readFileSync(join(home, "tasks", "bg_demo.json"), "utf8"))
    const session = JSON.parse(readFileSync(join(project, ".kkcode", "longagent-state.json"), "utf8"))
    assert.equal(task.cancelled, true)
    assert.equal(session.sessions.ses_demo.backgroundTaskStatus, "cancel_requested")
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test("e2e: longagent retry-task retries linked background task", () => {
  const home = mkdtempSync(join(tmpdir(), "kkcode-e2e-longagent-retry-home-"))
  const project = mkdtempSync(join(tmpdir(), "kkcode-e2e-longagent-retry-project-"))
  try {
    mkdirSync(join(project, ".kkcode"), { recursive: true })
    mkdirSync(join(home, "tasks"), { recursive: true })
    writeFileSync(join(project, ".kkcode", "longagent-state.json"), JSON.stringify({
      sessions: {
        ses_demo: {
          sessionId: "ses_demo",
          status: "interrupted",
          phase: "H4",
          objective: "demo",
          backgroundTaskId: "bg_demo",
          backgroundTaskStatus: "interrupted",
          backgroundTaskAttempt: 1,
          backgroundTaskUpdatedAt: 1234567890,
          createdAt: 1,
          updatedAt: 1
        }
      }
    }, null, 2))
    writeFileSync(join(home, "tasks", "bg_demo.json"), JSON.stringify({
      id: "bg_demo",
      status: "interrupted",
      attempt: 1,
      updatedAt: 1234567890,
      cancelled: false,
      payload: {},
      backgroundMode: "inline"
    }, null, 2))
    const { stdout } = run(["longagent", "retry-task", "--session", "ses_demo"], {
      cwd: project,
      env: { KKCODE_HOME: home }
    })
    assert.ok(stdout.includes("background retry queued: bg_demo (attempt=2)"))
    const task = JSON.parse(readFileSync(join(home, "tasks", "bg_demo.json"), "utf8"))
    const session = JSON.parse(readFileSync(join(project, ".kkcode", "longagent-state.json"), "utf8"))
    assert.equal(task.status, "pending")
    assert.equal(task.attempt, 2)
    assert.equal(session.sessions.ses_demo.backgroundTaskAttempt, 2)
    assert.equal(session.sessions.ses_demo.status, "pending")
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test("e2e: longagent recover relaunches missing linked background task", () => {
  const home = mkdtempSync(join(tmpdir(), "kkcode-e2e-longagent-recover-home-"))
  const project = mkdtempSync(join(tmpdir(), "kkcode-e2e-longagent-recover-project-"))
  try {
    mkdirSync(join(project, ".kkcode"), { recursive: true })
    writeFileSync(join(project, ".kkcode", "longagent-state.json"), JSON.stringify({
      sessions: {
        ses_demo: {
          sessionId: "ses_demo",
          status: "interrupted",
          phase: "H4",
          objective: "recover demo",
          providerType: "openai",
          model: "gpt-5",
          maxIterations: 12,
          backgroundTaskId: "bg_missing",
          backgroundTaskStatus: "interrupted",
          backgroundTaskAttempt: 1,
          backgroundTaskUpdatedAt: 1234567890,
          stopRequested: true,
          createdAt: 1,
          updatedAt: 1
        }
      }
    }, null, 2))
    const { stdout } = run(["longagent", "recover", "--session", "ses_demo"], {
      cwd: project,
      env: { KKCODE_HOME: home, OPENAI_API_KEY: "test-key" }
    })
    assert.ok(stdout.includes("background recovery relaunched: bg_"))
    const session = JSON.parse(readFileSync(join(project, ".kkcode", "longagent-state.json"), "utf8"))
    assert.equal(session.sessions.ses_demo.stopRequested, false)
    assert.equal(session.sessions.ses_demo.status, "pending")
    assert.equal(session.sessions.ses_demo.providerType, "openai")
    assert.equal(session.sessions.ses_demo.model, "gpt-5")
    assert.ok(String(session.sessions.ses_demo.backgroundTaskId || "").startsWith("bg_"))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test("e2e: longagent recover-checkpoint queues focused recovery", () => {
  const home = mkdtempSync(join(tmpdir(), "kkcode-e2e-longagent-checkpoint-home-"))
  const project = mkdtempSync(join(tmpdir(), "kkcode-e2e-longagent-checkpoint-project-"))
  try {
    mkdirSync(join(project, ".kkcode"), { recursive: true })
    writeFileSync(join(project, ".kkcode", "longagent-state.json"), JSON.stringify({
      sessions: {
        ses_demo: {
          sessionId: "ses_demo",
          status: "interrupted",
          phase: "H3",
          objective: "recover checkpoint demo",
          providerType: "openai",
          model: "gpt-5",
          checkpoints: [
            {
              id: "chk_demo",
              phase: "H2",
              kind: "phase",
              stageId: "api-wiring",
              taskId: "task_fix",
              summary: "api wiring failed"
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      }
    }, null, 2))
    const { stdout } = run(["longagent", "recover-checkpoint", "--session", "ses_demo", "--checkpoint", "chk_demo"], {
      cwd: project,
      env: { KKCODE_HOME: home, OPENAI_API_KEY: "test-key" }
    })
    assert.ok(stdout.includes("checkpoint recovery queued: bg_"))
    const session = JSON.parse(readFileSync(join(project, ".kkcode", "longagent-state.json"), "utf8"))
    assert.equal(session.sessions.ses_demo.status, "pending")
    assert.equal(session.sessions.ses_demo.phase, "H2")
    assert.equal(session.sessions.ses_demo.currentStageId, "api-wiring")
    assert.ok(String(session.sessions.ses_demo.backgroundTaskId || "").startsWith("bg_"))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test("e2e: longagent retry-task-run queues focused task retry", () => {
  const home = mkdtempSync(join(tmpdir(), "kkcode-e2e-longagent-task-retry-home-"))
  const project = mkdtempSync(join(tmpdir(), "kkcode-e2e-longagent-task-retry-project-"))
  try {
    mkdirSync(join(project, ".kkcode"), { recursive: true })
    writeFileSync(join(project, ".kkcode", "longagent-state.json"), JSON.stringify({
      sessions: {
        ses_demo: {
          sessionId: "ses_demo",
          status: "interrupted",
          phase: "H4",
          objective: "retry task demo",
          providerType: "openai",
          model: "gpt-5",
          currentStageId: "api-wiring",
          taskProgress: {
            task_fix: {
              status: "failed",
              attempt: 2,
              lastError: "TypeError: boom"
            }
          },
          createdAt: 1,
          updatedAt: 1
        }
      }
    }, null, 2))
    const { stdout } = run(["longagent", "retry-task-run", "--session", "ses_demo", "--task", "task_fix"], {
      cwd: project,
      env: { KKCODE_HOME: home, OPENAI_API_KEY: "test-key" }
    })
    assert.ok(stdout.includes("task retry queued: bg_"))
    const session = JSON.parse(readFileSync(join(project, ".kkcode", "longagent-state.json"), "utf8"))
    assert.equal(session.sessions.ses_demo.status, "pending")
    assert.equal(session.sessions.ses_demo.retryStageId, "api-wiring")
    assert.ok(String(session.sessions.ses_demo.backgroundTaskId || "").startsWith("bg_"))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

// background list
test("e2e: background list exits 0", () => {
  run(["background", "list"])
})

test("e2e: background center exits 0", () => {
  const { stdout } = run(["background", "center"])
  assert.ok(stdout.includes("tasks: total="))
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

test("e2e: auth list --json exits 0", () => {
  const { stdout } = run(["auth", "list", "--json"])
  const parsed = JSON.parse(stdout)
  assert.ok(Array.isArray(parsed), "should return array")
})

test("e2e: auth providers lists catalog auth capabilities", () => {
  const { stdout } = run(["auth", "providers", "--json"])
  const providers = JSON.parse(stdout)
  assert.ok(Array.isArray(providers))
  assert.ok(providers.some((item) => item.id === "minimax-portal"))
  assert.ok(providers.some((item) => item.id === "xai"))
  assert.ok(providers.some((item) => item.id === "moonshot"))
  assert.ok(providers.some((item) => item.id === "xiaomi"))
})

test("e2e: auth probe reports provider runtime details", () => {
  const home = mkdtempSync(join(tmpdir(), "kkcode-e2e-auth-probe-"))
  const project = mkdtempSync(join(tmpdir(), "kkcode-e2e-auth-probe-project-"))
  try {
    writeFileSync(join(project, "kkcode.config.json"), JSON.stringify({
      provider: {
        default: "openai",
        openai: {
          default_model: "gpt-5.3-codex",
          api_key_env: "OPENAI_API_KEY",
          fallback_models: ["openrouter::openai/gpt-4.1-mini"]
        },
        openrouter: {
          type: "openai-compatible",
          base_url: "https://openrouter.ai/api/v1",
          default_model: "openai/gpt-4.1-mini",
          api_key_env: "OPENROUTER_API_KEY"
        }
      }
    }, null, 2))
    const { stdout } = run(["auth", "probe", "openai"], {
      cwd: project,
      env: {
        KKCODE_HOME: home,
        OPENAI_API_KEY: "test-key",
        OPENROUTER_API_KEY: "router-key"
      }
    })
    assert.ok(stdout.includes("provider: openai"))
    assert.ok(stdout.includes("attempt chain:"))
    assert.ok(stdout.includes("primary openai::gpt-5.3-codex"))
    assert.ok(stdout.includes("fallback openrouter::openai/gpt-4.1-mini"))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test("e2e: auth login starts generic browser oauth flow and pending-oauth shows session", () => {
  const home = mkdtempSync(join(tmpdir(), "kkcode-e2e-auth-oauth-home-"))
  try {
    const login = run([
      "auth", "login", "openai-codex",
      "--auth-url", "https://auth.example.com/oauth/authorize",
      "--client-id", "client_123",
      "--token-url", "https://auth.example.com/oauth/token"
    ], { env: { KKCODE_HOME: home } })
    assert.match(login.stdout, /open: https:\/\/auth\.example\.com\/oauth\/authorize/)
    const pending = run(["auth", "pending-oauth"], { env: { KKCODE_HOME: home } })
    const parsed = JSON.parse(pending.stdout)
    assert.equal(parsed.providerId, "openai-codex")
    assert.equal(parsed.clientId, "client_123")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("e2e: auth import-callback stores oauth profile from token callback", () => {
  const home = mkdtempSync(join(tmpdir(), "kkcode-e2e-auth-import-home-"))
  try {
    const login = run([
      "auth", "login", "openai-codex",
      "--auth-url", "https://auth.example.com/oauth/authorize",
      "--client-id", "client_123",
      "--token-url", "https://auth.example.com/oauth/token"
    ], { env: { KKCODE_HOME: home } })
    const stateMatch = login.stdout.match(/state:\s+([A-Za-z0-9_]+)/)
    assert.ok(stateMatch)
    const callbackUrl = `kkcode://oauth#state=${stateMatch[1]}&access_token=tok_cli_123&refresh_token=ref_cli_456&expires_in=3600`
    const imported = run([
      "auth", "import-callback", "openai-codex",
      "--url", callbackUrl,
      "--name", "Codex OAuth"
    ], { env: { KKCODE_HOME: home } })
    assert.ok(imported.stdout.includes("auth_"))
    const listed = run(["auth", "list", "--json"], { env: { KKCODE_HOME: home } })
    const profiles = JSON.parse(listed.stdout)
    assert.equal(profiles.length, 1)
    assert.equal(profiles[0].providerId, "openai-codex")
    assert.equal(profiles[0].displayName, "Codex OAuth")
    assert.equal(profiles[0].authMode, "oauth")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("e2e: longagent status prints readable recovery summary by default", () => {
  const project = mkdtempSync(join(tmpdir(), "kkcode-e2e-longagent-status-project-"))
  try {
    mkdirSync(join(project, ".kkcode"), { recursive: true })
    writeFileSync(join(project, ".kkcode", "longagent-state.json"), JSON.stringify({
      sessions: {
        ses_demo: {
          sessionId: "ses_demo",
          status: "error",
          phase: "H5",
          currentGate: "test",
          objective: "recover demo",
          providerType: "openai",
          model: "gpt-5",
          progress: { percentage: 75, currentStep: 3, totalSteps: 4 },
          recoveryCount: 2,
          heartbeatAt: Date.now() - 1000,
          updatedAt: Date.now() - 2000,
          currentStageId: "api-wiring",
          stageIndex: 1,
          stageCount: 3,
          remainingFilesCount: 1,
          iterations: 4,
          maxIterations: 8,
          backgroundTaskId: "bg_demo",
          backgroundTaskStatus: "interrupted",
          backgroundTaskAttempt: 2,
          lastMessage: "background worker exited unexpectedly",
          lastStageReport: {
            stageId: "api-wiring",
            status: "fail",
            successCount: 2,
            failCount: 1,
            retryCount: 1,
            remainingFilesCount: 1,
            remainingFiles: ["src/api.mjs"]
          },
          checkpoints: [
            { id: "cp_latest", kind: "manual_recovery", phase: "H5", summary: "retry from test failure" }
          ],
          recoverySuggestions: ["rerun recover command"]
        }
      }
    }, null, 2))
    const { stdout } = run(["longagent", "status", "--session", "ses_demo"], { cwd: project })
    assert.ok(stdout.includes("session: ses_demo"))
    assert.ok(stdout.includes("recovery suggestions:"))
    assert.ok(stdout.includes("hint: kkcode longagent recover --session ses_demo"))
    assert.ok(stdout.includes("hint: kkcode longagent recover-checkpoint --session ses_demo --checkpoint cp_latest"))
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test("e2e: longagent checkpoints prints recommended checkpoint summary by default", () => {
  const project = mkdtempSync(join(tmpdir(), "kkcode-e2e-longagent-checkpoints-project-"))
  try {
    mkdirSync(join(project, ".kkcode"), { recursive: true })
    writeFileSync(join(project, ".kkcode", "longagent-state.json"), JSON.stringify({
      sessions: {
        ses_demo: {
          sessionId: "ses_demo",
          status: "error",
          phase: "H5",
          currentGate: "test",
          providerType: "openai",
          model: "gpt-5",
          recoveryCount: 2,
          lastStageReport: {
            stageId: "api-wiring",
            status: "fail"
          },
          checkpoints: [
            { id: "cp_old", kind: "phase", phase: "H4", summary: "started fix" },
            { id: "cp_latest", kind: "manual_recovery", phase: "H5", summary: "retry from test failure" }
          ]
        }
      }
    }, null, 2))
    const { stdout } = run(["longagent", "checkpoints", "--session", "ses_demo"], { cwd: project })
    assert.ok(stdout.includes("session: ses_demo"))
    assert.ok(stdout.includes("cp_latest  H5  manual_recovery [latest, recommended]"))
    assert.ok(stdout.includes("recommended: kkcode longagent recover-checkpoint --session ses_demo --checkpoint cp_latest"))
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
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
