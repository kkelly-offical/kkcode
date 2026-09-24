import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"

const originalCwd = process.cwd()
const previousHome = process.env.KKCODE_HOME
const root = await mkdtemp(path.join(os.tmpdir(), "kk-ultra-acceptance-"))
process.env.KKCODE_HOME = path.join(root, "private-state")
const { registerProvider } = await import("../src/kernel/provider/router.mjs")
const { runHybridLongAgent } = await import("../src/kernel/session/longagent-hybrid.mjs")
const { runGateCommand } = await import("../src/kernel/session/gate-command.mjs")
const { flushNow, configureSessionStore } = await import("../src/kernel/session/store.mjs")
configureSessionStore({ flushIntervalMs: 0 })
const { prepareHostAcceptance, restoreHostAcceptance, validateAcceptanceManifest } = await import("../src/kernel/session/acceptance-manifest.mjs")
const { createScriptedProvider, stagePlanFence, ultraConfig } = await import("./helpers/ultra-harness.mjs")
const { installBackgroundMock, restoreBackgroundMock } = await import("./helpers/background-mock.mjs")

// Production strict execution uses a Linux container. This test callback runs
// only synthetic fixture commands on the host, including Windows npm's launcher.
function fixtureCommand(request) {
  if (process.platform === "win32" && request.command === "npm") {
    const npmCli = process.env.npm_execpath
    return runGateCommand(npmCli && /\.[cm]?js$/i.test(npmCli)
      ? { ...request, command: process.execPath, args: [npmCli, ...request.args] }
      : { ...request, command: "npm.cmd", shell: true })
  }
  return runGateCommand(request)
}

test.after(async () => {
  restoreBackgroundMock()
  await flushNow()
  process.chdir(originalCwd)
  if (previousHome === undefined) delete process.env.KKCODE_HOME
  else process.env.KKCODE_HOME = previousHome
  await rm(root, { recursive: true, force: true })
})

async function fixture(t) {
  const cwd = await mkdtemp(path.join(root, "repo-"))
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git("init")
  git("config", "user.email", "test@example.invalid")
  git("config", "user.name", "Acceptance Test")
  git("config", "core.autocrlf", "false")
  await mkdir(path.join(cwd, "src"))
  await mkdir(path.join(cwd, "test"))
  await writeFile(path.join(cwd, "src/out.mjs"), "export const version = 1\n")
  await writeFile(path.join(cwd, "test/check.mjs"), "import { version } from '../src/out.mjs'; if(version !== 2) process.exit(1)\n")
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node test/check.mjs" } }))
  git("add", ".")
  git("commit", "-m", "baseline")
  const goal = { goalId: "approved-contract", objective: "implement version two without weakening tests", criteria: [
    { id: "host-test", kind: "gate_pass", text: "original test passes", spec: { gate: "test" } },
    { id: "host-version", kind: "content_match", text: "version two implemented", spec: { path: "src/out.mjs", pattern: "version = 2" } }
  ] }
  const input = { required: true, goal, testSources: ["test/check.mjs", "package.json"] }
  const configState = ultraConfig({ providerName: "mock_bound_ultra", gates: { test: { enabled: true }, smoke: { enabled: false } } }, { ultra: { max_rounds: 1 } })
  // A host-bound review records an exact route identity even when the provider
  // is an in-memory fixture. The registered mock still handles every request;
  // this reserved .invalid endpoint is identity metadata, not a live API.
  Object.assign(configState.config.provider.mock_bound_ultra, { type: "openai", base_url: "https://ultra-fixture.invalid/v1", api_key_env: "" })
  process.chdir(cwd)
  t.after(() => { restoreBackgroundMock(); process.chdir(originalCwd) })
  return { cwd, input, configState, git }
}

async function execute(f, { behavior = null, onReceipt = null, onRequest = null, commandRunner = null, acceptance = null, interaction = null } = {}) {
  const receipts = [], commands = []
  let backgroundCalls = 0, strictStageCalls = 0, reviewCalls = 0
  const implement = async payload => {
    await writeFile(path.join(f.cwd, "src/out.mjs"), "export const version = 2\n")
    if (behavior) await behavior(payload)
  }
  const plan = {
    planId: "model-plan", objective: "implement version two",
    // A deliberately weaker model goal must never replace the host contract.
    goal: { criteria: ["src/out.mjs"] },
    stages: [{ stageId: "implementation", name: "Implementation", tasks: [{
      taskId: "write-output", prompt: "implement version two", plannedFiles: ["src/out.mjs"], acceptance: ["src/out.mjs"]
    }] }]
  }
  const scripted = createScriptedProvider([
    { match: /Strict delegated stage/, reply: "[TASK_COMPLETE] stage execution finished" },
    { stage: 1, reply: "Existing project and frozen tests inspected." },
    { stage: 2, reply: stagePlanFence(plan) },
    { stage: 4, reply: "[STAGE 4/4: DEBUGGING - COMPLETE]\n[TASK_COMPLETE]" }
  ], { onRequest })
  const observeStrictStage = async input => {
    const lastUser = [...(input.messages || [])].reverse().find(message => message.role === "user")
    if (JSON.stringify(lastUser?.content || "").includes("Strict delegated stage")) {
      strictStageCalls++
      await implement({ prompt: "strict stage" })
    }
  }
  registerProvider("mock_bound_ultra", { ...scripted,
    async request(input) {
      if (String(input.system || "").includes("independent code-review assistant")) {
        reviewCalls++
        assert.deepEqual(input.tools, [])
        const envelope = JSON.parse(input.messages[0].content)
        return { text: JSON.stringify({ decision: "approved", summary: "All fixture changes reviewed.",
          files: envelope.completeFileInventory.map(file => ({ path: file.path, reviewed: true, findings: [] })) }), usage: { input: 1, output: 1 } }
      }
      await observeStrictStage(input); return scripted.request(input)
    },
    async *requestStream(input) { await observeStrictStage(input); yield* scripted.requestStream(input) }
  })
  installBackgroundMock({ reply: "[TASK_COMPLETE] done", behavior: async payload => {
    backgroundCalls++
    await implement(payload)
    return null
  } })
  const result = await runHybridLongAgent({
    prompt: "implement version two and verify the original test suite", model: "mock-model", providerType: "mock_bound_ultra",
    sessionId: `bound-${randomUUID()}`, configState: f.configState, allowQuestion: Boolean(interaction),
    ...(interaction ? { deps: { hasPromptHandler: () => true, askQuestionInteractive: interaction } } : {}),
    acceptance: acceptance || { ...f.input,
      runCommand: async request => { commands.push(request); return commandRunner ? commandRunner(request) : fixtureCommand(request) },
      onReceipt: async receipt => { receipts.push(receipt); if (onReceipt) await onReceipt(receipt) }
    }
  })
  return { result, receipts, commands, backgroundCalls, strictStageCalls, reviewCalls }
}

test("real Ultra captures original sources before work and enforces the host contract", async t => {
  const f = await fixture(t)
  f.configState.config.agent.longagent.hybrid.completion_validation = true
  const originalTest = await readFile(path.join(f.cwd, "test/check.mjs"), "utf8")
  const { result, receipts, commands, backgroundCalls, strictStageCalls } = await execute(f)
  assert.equal(result.status, "completed", JSON.stringify({ verification: result.goalVerification, gates: result.gateStatus, receipt: result.acceptance.receipt }))
  assert.equal(result.goal.goalId, "approved-contract")
  assert.deepEqual(result.goal.criteria.map(item => item.id), ["host-test", "host-version"])
  assert.equal(result.acceptance.mode, "host_bound")
  assert.equal(result.acceptance.manifest.independentSourceBaseline, true)
  assert.equal(result.goalVerification.acceptance.ok, true)
  assert.equal(receipts.length, 1)
  assert.match(receipts[0].candidateHash, /^[a-f0-9]{64}$/)
  assert.deepEqual(receipts[0].criteria.map(item => item.status), ["passed", "passed"])
  assert.equal(commands.length, 1, "the test gate must use the host execution callback")
  assert.equal(commands[0].shell, false)
  assert.equal(backgroundCalls, 0, "strict stages never fork legacy background workers")
  assert.equal(strictStageCalls, 1, "strict stage runs through the same control-plane provider")
  assert.equal(result.gateStatus.completionValidation.status, "informational", "strict completion validation never runs the legacy host subprocess validator")
  assert.equal(await readFile(path.join(f.cwd, "test/check.mjs"), "utf8"), originalTest)
})

test("weakening a frozen test in the coding stage cannot be blessed by a later manifest", async t => {
  const f = await fixture(t)
  const { result, commands, receipts } = await execute(f, { behavior: async () => {
    await writeFile(path.join(f.cwd, "test/check.mjs"), "process.exit(0)\n")
  } })
  assert.notEqual(result.status, "completed")
  assert.equal(result.goalVerification.status, "unknown")
  assert.equal(commands.length, 0, "weakened acceptance must not execute")
  assert.equal(receipts.length, 0)
})

test("host dependency identity is bound into verification commands without private mount paths", async t => {
  const f = await fixture(t)
  const dependency = { id: "npm-fixture", planId: "1".repeat(64), treeHash: "2".repeat(64), imageId: `sha256:${"3".repeat(64)}` }
  const { result, receipts } = await execute(f, { commandRunner: async request => ({
    ...await fixtureCommand(request),
    isolation: { imageId: dependency.imageId, workspace: "/private/verification", containerId: "not-a-receipt-field",
      dependencyEnvironment: { ...dependency, source: "/private/dependencies/node_modules" } }
  }) })
  assert.equal(result.status, "completed")
  assert.deepEqual(receipts[0].commands[0].isolation, { dependencyEnvironment: dependency })
  assert.equal(JSON.stringify(receipts[0].commands).includes("/private/"), false)
})

test("invalid host dependency evidence cannot produce a passing verification receipt", async t => {
  const f = await fixture(t)
  const receipts = []
  await assert.rejects(execute(f, { onReceipt: receipt => receipts.push(receipt), commandRunner: async request => ({
    ...await fixtureCommand(request), isolation: { dependencyEnvironment: { id: "npm-fixture", planId: "not-a-hash" } }
  }) }), /invalid dependency environment evidence/)
  assert.equal(receipts.length, 0)
})

test("real strict Ultra runs a no-tools independent review and binds its receipt to the candidate", async t => {
  const f = await fixture(t)
  f.configState.config.agent.longagent.usability_gates.review.enabled = true
  f.input.goal.criteria.push({ id: "host-review", kind: "gate_pass", text: "independent review passes", spec: { gate: "review" } })
  const { result, receipts, reviewCalls } = await execute(f)
  assert.equal(result.status, "completed", JSON.stringify(result.goalVerification))
  assert.equal(reviewCalls, 1)
  assert.equal(receipts[0].gates.review.status, "pass")
  assert.equal(receipts[0].allPass, true)
})

test("package scripts are frozen even when caller names only the assertion file", async t => {
  const f = await fixture(t)
  f.input.testSources = ["test/check.mjs"]
  f.configState.config.agent.longagent.ultra.goal_mode = false
  const { result, commands } = await execute(f, { behavior: async () => {
    await writeFile(path.join(f.cwd, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }))
  } })
  assert.notEqual(result.status, "completed", "goal_mode=false must not disable strict acceptance")
  assert.equal(commands.length, 0)
  assert.equal(result.goalVerification.status, "unknown")
})

test("candidate mutation during the actual gate invalidates a successful command", async t => {
  const f = await fixture(t)
  const { result, receipts } = await execute(f, { commandRunner: async request => {
    const outcome = await fixtureCommand(request)
    await writeFile(path.join(f.cwd, "src/out.mjs"), "export const version = 3\n")
    return outcome
  } })
  assert.notEqual(result.status, "completed")
  assert.equal(result.goalVerification.status, "unknown")
  assert.equal(receipts.length, 0)
})

test("owner callback rejection cannot leave a completed status", async t => {
  const f = await fixture(t)
  const { result } = await execute(f, { onReceipt: async () => { throw new Error("owner epoch expired") } })
  assert.notEqual(result.status, "completed")
  assert.equal(result.acceptance.receipt, null)
  assert.equal(result.goalVerification.status, "unknown")
})

test("changing the candidate after receipt invalidates completion and its old manifest", async t => {
  const f = await fixture(t)
  const { result, receipts } = await execute(f, { onReceipt: async () => {
    await writeFile(path.join(f.cwd, "late.txt"), "new candidate change\n")
  } })
  assert.equal(receipts.length, 1)
  assert.notEqual(result.status, "completed")
  assert.equal(result.goalVerification.status, "unknown")
  assert.equal((await validateAcceptanceManifest(result.acceptance.manifest, { goal: result.goal, cwd: f.cwd, config: f.configState.config })).ok, false)
})

test("strict inputs fail closed before model calls; legacy runs are explicitly unbound", async t => {
  const f = await fixture(t)
  let calls = 0
  for (const acceptance of [
    { required: true },
    { ...f.input, testSources: [] },
    { ...f.input, runCommand: null, onReceipt: async () => {} }
  ]) {
    await assert.rejects(execute(f, { acceptance, onRequest: () => { calls++ } }), /strict acceptance/)
  }
  assert.equal(calls, 0)
  const legacy = await execute(f, { acceptance: { required: false } })
  assert.equal(legacy.result.acceptance.mode, "legacy_unbound")
  assert.equal(legacy.result.gateStatus.acceptance.status, "legacy_unbound")
})

test("original host boundary survives serialization and refuses changed sources on resume", async t => {
  const f = await fixture(t)
  const boundary = await prepareHostAcceptance({ cwd: f.cwd, acceptance: f.input })
  const persisted = JSON.parse(JSON.stringify(boundary))
  const receipts = []
  const restored = await restoreHostAcceptance(persisted, { cwd: f.cwd, runCommand: fixtureCommand, onReceipt: async receipt => { receipts.push(receipt) } })
  const { result } = await execute(f, { acceptance: restored })
  assert.equal(result.status, "completed", result.reply)
  assert.equal(receipts[0].boundaryId, boundary.id)
  await writeFile(path.join(f.cwd, "test/check.mjs"), "process.exit(0)\n")
  await assert.rejects(restoreHostAcceptance(persisted, { cwd: f.cwd, runCommand: fixtureCommand, onReceipt: async () => {} }), /original acceptance sources changed/)
})

test("strict manual approval is not carried to a different candidate in the next round", async t => {
  const f = await fixture(t)
  f.configState.config.agent.longagent.ultra.max_rounds = 2
  f.input.goal.criteria[1].spec.pattern = "version = [23]"
  f.input.goal.criteria.push({ id: "manual-look", kind: "manual", text: "用户已检查当前候选", spec: { question: "当前候选可接受吗？" } })
  await writeFile(path.join(f.cwd, "test/check.mjs"), "import { version } from '../src/out.mjs'; if(version < 2) process.exit(1)\n")
  let gateCalls = 0, manualPrompts = 0, stages = 0
  const { result } = await execute(f, {
    commandRunner: async request => { gateCalls++; return gateCalls === 1 ? { ok: false, code: 1, stdout: "synthetic first-round failure", stderr: "" } : fixtureCommand(request) },
    behavior: async () => { if (++stages > 1) await writeFile(path.join(f.cwd, "src/out.mjs"), "export const version = 3\n") },
    onRequest: ({ last }) => { if (last.includes("重规划原因")) writeFileSync(path.join(f.cwd, "src/out.mjs"), "export const version = 3\n") },
    interaction: async ({ questions }) => {
      if (questions.some(question => question.id === "manual-look")) { manualPrompts++; return { "manual-look": manualPrompts === 1 ? "yes" : "no" } }
      return { ultra_blocked: "deliver_partial" }
    }
  })
  assert.equal(manualPrompts, 2, "new candidate requires a new explicit manual confirmation")
  assert.notEqual(result.status, "completed")
})

test("strict approval made while the candidate changes is rejected before applying it", async t => {
  const f = await fixture(t)
  f.input.goal.criteria.push({ id: "manual-look", kind: "manual", text: "用户确认", spec: { question: "确认当前候选？" } })
  const { result, receipts } = await execute(f, { interaction: async ({ questions }) => {
    if (questions.some(question => question.id === "manual-look")) {
      await writeFile(path.join(f.cwd, "late-change.txt"), "candidate changed while awaiting user\n")
      return { "manual-look": "yes" }
    }
    return { ultra_blocked: "deliver_partial" }
  } })
  assert.notEqual(result.status, "completed")
  assert.ok(receipts.every(receipt => !receipt.allPass))
  assert.equal(result.acceptance.receipt, null)
})
