import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { captureAcceptanceManifest, captureAcceptanceSources, validateAcceptanceManifest } from "../src/kernel/session/acceptance-manifest.mjs"
import { normalizeGoal, freezeGoal } from "../src/kernel/session/goal-model.mjs"
import { verifyGoal, GOAL_MET, GOAL_UNKNOWN } from "../src/kernel/session/goal-verifier.mjs"
import { runUsabilityGates, describeUsabilityGateCommands } from "../src/kernel/session/usability-gates.mjs"
import { GATE_NAMES } from "../src/kernel/session/gate-contract.mjs"

let cwd
let goal
const disabled = { agent: { longagent: { usability_gates: Object.fromEntries(GATE_NAMES.map((name) => [name, { enabled: false }])) } } }
const git = (...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim()

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "kk-acceptance-manifest-"))
  git("init", "-b", "main")
  git("config", "user.email", "test@example.invalid")
  git("config", "user.name", "Acceptance Test")
  await writeFile(path.join(cwd, "app.mjs"), "export const ready = true\n")
  await mkdir(path.join(cwd, "test"))
  await writeFile(path.join(cwd, "test", "check.mjs"), "process.exit(0)\n")
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node test/check.mjs" } }))
  git("add", ".")
  git("commit", "-m", "baseline")
  goal = freezeGoal(normalizeGoal({ goalId: "goal-test", objective: "deliver", criteria: ["node test/check.mjs", "app.mjs"] }).goal)
})

afterEach(async () => { await rm(cwd, { recursive: true, force: true }) })

test("manifest binds real candidate, acceptance commands, and original test sources", async () => {
  const sources = await captureAcceptanceSources({ cwd, paths: ["test/check.mjs", "package.json"] })
  const manifest = await captureAcceptanceManifest({ goal, cwd, sourceBaseline: sources })
  assert.equal(manifest.independentSourceBaseline, true)
  assert.equal(Object.isFrozen(manifest.sources.files), true)
  assert.equal((await validateAcceptanceManifest(manifest, { goal, cwd })).ok, true)
  const result = await verifyGoal({ goal, cwd, acceptanceManifest: manifest })
  assert.equal(result.status, GOAL_MET)
  assert.equal(result.acceptance.manifestId, manifest.id)
  const changed = structuredClone(goal)
  changed.criteria[0].spec.args = ["-e", "process.exit(0)"]
  const stale = await validateAcceptanceManifest(manifest, { goal: changed, cwd })
  assert.ok(stale.errors.includes("acceptance commands changed"))
})

test("changed candidate is rejected before any acceptance command executes", async () => {
  const manifest = await captureAcceptanceManifest({ goal, cwd })
  await writeFile(path.join(cwd, "new-file.mjs"), "export const changed = 1\n")
  let calls = 0
  const result = await verifyGoal({ goal, cwd, acceptanceManifest: manifest, deps: { runGateCommand: async () => { calls++; return { code: 0 } } } })
  assert.equal(result.status, GOAL_UNKNOWN)
  assert.equal(calls, 0)
  assert.ok(result.acceptance.errors.includes("acceptance candidate changed"))
})

test("source mutation during execution invalidates an otherwise successful result", async () => {
  const manifest = await captureAcceptanceManifest({ goal, cwd, testSources: ["test/check.mjs"] })
  const result = await verifyGoal({ goal, cwd, acceptanceManifest: manifest, deps: { runGateCommand: async () => {
    await writeFile(path.join(cwd, "test", "check.mjs"), "// replaced test\nprocess.exit(0)\n")
    return { code: 0, stdout: "success", stderr: "" }
  } } })
  assert.equal(result.status, GOAL_UNKNOWN)
  assert.ok(result.acceptance.errors.includes("acceptance test sources changed"))
})

test("host baseline cannot be silently recaptured after test weakening", async () => {
  const sourceBaseline = await captureAcceptanceSources({ cwd, paths: ["test/check.mjs"] })
  await writeFile(path.join(cwd, "test", "check.mjs"), "// disabled acceptance\n")
  await assert.rejects(captureAcceptanceManifest({ goal, cwd, sourceBaseline }), /host-approved baseline/)
  await assert.rejects(captureAcceptanceSources({ cwd, paths: ["../outside"] }), /outside/)
  await assert.rejects(captureAcceptanceSources({ cwd, paths: ["missing.mjs"] }), /must exist/)
})

test("corrupt manifest and mismatched gate receipts cannot prove completion", async () => {
  goal = freezeGoal(normalizeGoal({ criteria: ["test passes"] }).goal)
  const manifest = await captureAcceptanceManifest({ goal, cwd })
  const corrupt = structuredClone(manifest)
  corrupt.candidate.treeFingerprint = "0".repeat(64)
  assert.equal((await validateAcceptanceManifest(corrupt, { goal, cwd })).ok, false)
  const gates = await runUsabilityGates({ goal, cwd, acceptanceManifest: manifest, sessionId: "manifest", config: {
    agent: { longagent: { usability_gates: { ...disabled.agent.longagent.usability_gates, test: { enabled: true } } } }
  } })
  assert.equal(gates.allPass, true)
  assert.equal((await verifyGoal({ goal, cwd, acceptanceManifest: manifest, gateResult: gates })).status, GOAL_MET)
  const staleGate = { ...gates, acceptance: { ...gates.acceptance, manifestId: "other-candidate" } }
  assert.equal((await verifyGoal({ goal, cwd, acceptanceManifest: manifest, gateResult: staleGate })).status, GOAL_UNKNOWN)
  await writeFile(path.join(cwd, "app.mjs"), "changed\n")
  const stale = await runUsabilityGates({ goal, cwd, acceptanceManifest: manifest, config: disabled })
  assert.equal(stale.allPass, false, "no enabled gates cannot conceal stale evidence")
})

test("changing HEAD or removing sources invalidates acceptance without mutating Git", async () => {
  const manifest = await captureAcceptanceManifest({ goal, cwd, testSources: ["test/check.mjs"] })
  const indexBefore = await readFile(path.join(cwd, ".git", "index"))
  await validateAcceptanceManifest(manifest, { goal, cwd })
  assert.deepEqual(await readFile(path.join(cwd, ".git", "index")), indexBefore)
  git("commit", "--allow-empty", "-m", "new candidate")
  assert.equal((await validateAcceptanceManifest(manifest, { goal, cwd })).ok, false)
})

test("a real successful test command changing sources cannot emit a passing gate", async () => {
  await writeFile(path.join(cwd, "test", "check.mjs"), "import { writeFileSync } from 'node:fs'; writeFileSync('app.mjs', 'changed'); process.exit(0)\n")
  goal = freezeGoal(normalizeGoal({ criteria: ["test passes"] }).goal)
  const manifest = await captureAcceptanceManifest({ goal, cwd, testSources: ["test/check.mjs"] })
  const result = await runUsabilityGates({ goal, cwd, acceptanceManifest: manifest, config: {
    agent: { longagent: { usability_gates: { ...disabled.agent.longagent.usability_gates, test: { enabled: true } } } }
  } })
  assert.equal(result.allPass, false)
  assert.equal(result.gates.test.status, "unknown")
  assert.equal(result.gates.test.executionStatus, "pass")
})

test("ignored build output does not change candidate identity; missing source still fails", async () => {
  await writeFile(path.join(cwd, ".gitignore"), "output.log\n")
  const manifest = await captureAcceptanceManifest({ goal, cwd, testSources: ["test/check.mjs"] })
  await writeFile(path.join(cwd, "output.log"), "generated during verification\n")
  assert.equal((await validateAcceptanceManifest(manifest, { goal, cwd })).ok, true)
  await rm(path.join(cwd, "test", "check.mjs"))
  assert.equal((await validateAcceptanceManifest(manifest, { goal, cwd })).ok, false)
})

test("strict gate descriptions use portable container commands and relative imports", async () => {
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ type: "module", main: "app.mjs", scripts: { test: "node test/check.mjs", build: "node --check app.mjs" } }))
  const config = { agent: { longagent: { usability_gates: { build: { enabled: true }, test: { enabled: true }, smoke: { enabled: true } } } } }
  const commands = await describeUsabilityGateCommands({ cwd, config, portable: true })
  assert.deepEqual(commands.map(command => command.command), ["npm", "npm", "node"])
  assert.equal(commands.every(command => command.shell === false), true)
  assert.equal(commands.some(command => JSON.stringify(command.args).includes("file://")), false)
  assert.equal(commands.some(command => JSON.stringify(command.args).includes(cwd)), false)
  assert.match(commands[2].args.at(-1), /import\("\.\/app\.mjs"\)/)
})

test("strict verification and gates refuse missing host binding instead of host execution", async () => {
  const manifest = await captureAcceptanceManifest({ goal, cwd, testSources: ["test/check.mjs"] })
  let calls = 0
  const commandRunner = async () => { calls++; return { ok: true, code: 0 } }
  const result = await verifyGoal({ goal, cwd, acceptanceManifest: manifest, acceptanceRequired: true, deps: { runGateCommand: commandRunner } })
  assert.equal(result.status, GOAL_UNKNOWN)
  const gates = await runUsabilityGates({ cwd, goal, config: disabled, acceptanceManifest: manifest, acceptanceRequired: true, commandRunner })
  assert.equal(gates.allPass, false)
  assert.equal(calls, 0)
})
