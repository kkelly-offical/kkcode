import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { execFileSync } from "node:child_process"
import { registerProvider } from "../src/provider/router.mjs"
import { processTurnLoop } from "../src/session/loop.mjs"
import { getSession, touchSession, flushNow } from "../src/session/store.mjs"
import { markTurnInProgress, markTurnFinished } from "../src/session/recovery.mjs"

const CLI = resolve("src/index.mjs")
const NODE = process.execPath

let home = ""
let project = ""
let oldCwd = process.cwd()
let oldHomeEnv = process.env.KKCODE_HOME

function runCli(args, { expectFail = false } = {}) {
  try {
    const stdout = execFileSync(NODE, [CLI, ...args], {
      cwd: project,
      env: { ...process.env, KKCODE_HOME: home, NO_COLOR: "1" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    })
    if (expectFail) throw new Error("expected non-zero exit code")
    return { code: 0, stdout }
  } catch (error) {
    if (!expectFail) throw error
    return {
      code: Number(error.status || 1),
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || "")
    }
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kkcode-recovery-home-"))
  project = await mkdtemp(join(tmpdir(), "kkcode-recovery-project-"))
  oldCwd = process.cwd()
  oldHomeEnv = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = home
  process.chdir(project)
})

afterEach(async () => {
  process.chdir(oldCwd)
  if (oldHomeEnv === undefined) delete process.env.KKCODE_HOME
  else process.env.KKCODE_HOME = oldHomeEnv
  await flushNow()
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

test("markTurnInProgress/Finished no-op when recovery disabled", async () => {
  const sessionId = `ses_toggle_${Date.now()}`
  await touchSession({
    sessionId,
    mode: "agent",
    model: "mock",
    providerType: "mock_toggle",
    cwd: project
  })

  await markTurnInProgress(sessionId, "turn1", 1, false)
  await markTurnFinished(sessionId, false)
  const data = await getSession(sessionId)
  assert.equal(data.session.retryMeta, null)
})

test("processTurnLoop does not write retryMeta failedAt when recovery disabled", async () => {
  registerProvider("mock_toggle", {
    async request() {
      throw new Error("unused")
    },
    async *requestStream() {
      throw new Error("forced provider failure")
    }
  })

  const sessionId = `ses_loop_toggle_${Date.now()}`
  const configState = {
    config: {
      provider: {
        default: "mock_toggle",
        mock_toggle: {
          default_model: "mock-model",
          stream: true
        }
      },
      agent: {
        max_steps: 1
      },
      permission: {
        default_policy: "allow",
        rules: []
      },
      session: {
        max_history: 10,
        recovery: false
      },
      tool: {
        sources: { builtin: false, local: false, plugin: false, mcp: false }
      },
      usage: {
        aggregation: ["turn"]
      },
      ui: {
        markdown_render: false
      }
    }
  }

  const result = await processTurnLoop({
    prompt: "hello",
    mode: "agent",
    model: "mock-model",
    providerType: "mock_toggle",
    sessionId,
    configState
  })

  assert.ok(result.reply.includes("provider error"))
  const data = await getSession(sessionId)
  assert.equal(Boolean(data.session.retryMeta?.failedAt), false)
})

test("session commands report disabled when session.recovery=false", async () => {
  await writeFile(
    join(project, "kkcode.config.yaml"),
    [
      "session:",
      "  recovery: false"
    ].join("\n") + "\n",
    "utf8"
  )

  const out = runCli(["session", "recoverable"], { expectFail: true })
  assert.equal(out.code, 2)
  assert.ok(`${out.stdout}\n${out.stderr}`.includes("session recovery is disabled"))
})

test("session picker lists recoverable sessions with resume commands", async () => {
  const sessionId = `ses_picker_${Date.now()}`
  await touchSession({
    sessionId,
    mode: "agent",
    model: "mock-model",
    providerType: "mock_toggle",
    cwd: project,
    status: "error",
    retryMeta: {
      inProgress: false,
      failedAt: Date.now()
    }
  })
  await flushNow()
  const out = runCli(["session", "picker"])
  assert.equal(out.code, 0)
  assert.ok(out.stdout.includes("recoverable sessions:"))
  assert.ok(out.stdout.includes(sessionId.slice(0, 12)))
  assert.ok(out.stdout.includes(`kkcode session resume --id ${sessionId}`))
  assert.ok(out.stdout.includes(`kkcode session retry --id ${sessionId}`))
})

test("session picker supports json selection by index", async () => {
  const sessionId = `ses_picker_json_${Date.now()}`
  await touchSession({
    sessionId,
    mode: "plan",
    model: "mock-model",
    providerType: "mock_toggle",
    cwd: project,
    status: "error",
    retryMeta: {
      inProgress: false,
      failedAt: Date.now()
    }
  })
  await flushNow()
  const out = runCli(["session", "picker", "--index", "1", "--json"])
  assert.equal(out.code, 0)
  const parsed = JSON.parse(out.stdout)
  assert.equal(parsed.id, sessionId)
  assert.equal(parsed.commands.resume, `kkcode session resume --id ${sessionId}`)
  assert.equal(parsed.commands.retry, `kkcode session retry --id ${sessionId}`)
})
