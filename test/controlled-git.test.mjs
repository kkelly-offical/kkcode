import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { runControlledGit, gitNullDevice } from "../src/util/controlled-git.mjs"
import { createDetachedWorktree, exportWorktreePatch, captureWorkingTreeState, removeWorktree } from "../src/util/git.mjs"
import { applyWorktreeResult } from "../src/kernel/orchestration/worktree-handoff.mjs"
import { writePromotionJson } from "../src/storage/promotion-journal.mjs"
import { backgroundTaskCheckpointPath } from "../src/storage/paths.mjs"
import { captureAcceptanceCandidate } from "../src/kernel/session/acceptance-manifest.mjs"

const exists = target => access(target).then(() => true, () => false)
const originalCwd = process.cwd()
const oldHome = process.env.KKCODE_HOME
const root = await mkdtemp(path.join(os.tmpdir(), "kk-controlled-git-"))
process.env.KKCODE_HOME = path.join(root, "state")
test.after(async () => {
  process.chdir(originalCwd)
  if (oldHome === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = oldHome
  await rm(root, { recursive: true, force: true })
})

test("Git null config paths use the Git-compatible Windows spelling, never Node's device namespace", () => {
  assert.equal(gitNullDevice("win32"), "NUL")
  assert.notEqual(gitNullDevice("win32"), "\\\\.\\nul")
  assert.equal(gitNullDevice("linux"), "/dev/null")
  assert.equal(gitNullDevice("darwin"), "/dev/null")
})

async function fixture(t) {
  const repo = await mkdtemp(path.join(root, "repo-"))
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid"); git("config", "core.autocrlf", "false")
  await writeFile(path.join(repo, "app.txt"), "before\n")
  await writeFile(path.join(repo, ".gitattributes"), "*.txt filter=probe diff=probe\n")
  git("add", "."); git("commit", "-m", "baseline")
  const candidate = await createDetachedWorktree(repo, "controlled-git-test")
  assert.equal(candidate.ok, true, candidate.error)
  await writeFile(path.join(candidate.path, "app.txt"), "after   \n")
  t.after(async () => {
    process.chdir(originalCwd)
    // Disarm synthetic configuration before the conventional cleanup path.
    for (const name of ["core.fsmonitor", "core.hooksPath", "filter.probe.clean", "filter.probe.process", "filter.probe.smudge", "diff.external", "diff.probe.command", "diff.probe.textconv"]) {
      try { git("config", "--unset", name) } catch { /* absent is fine */ }
    }
    if (await exists(candidate.path)) await removeWorktree(candidate.path, repo)
  })
  return { repo, git, candidate: candidate.path }
}

test("promotion disables repository filters, external diff/textconv, fsmonitor and reference hooks", async t => {
  const f = await fixture(t)
  const marker = path.join(root, "repository-code-ran")
  const script = path.join(root, "probe.cjs")
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');const chunks=[];process.stdin.on('data',chunk=>chunks.push(chunk));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(chunks)));`)
  const command = `"${process.execPath.replaceAll("\\", "/")}" "${script.replaceAll("\\", "/")}"`
  for (const name of ["filter.probe.clean", "filter.probe.smudge", "filter.probe.process", "diff.probe.command", "diff.probe.textconv", "diff.external", "core.fsmonitor"]) f.git("config", name, command)
  f.git("config", "filter.probe.required", "true")
  const hooks = path.join(root, "hostile-hooks")
  await mkdir(hooks)
  await writeFile(path.join(hooks, "reference-transaction"), `#!/bin/sh\n${command}\n`, { mode: 0o700 })
  f.git("config", "core.hooksPath", hooks)

  const fingerprint = await captureWorkingTreeState(f.repo)
  assert.equal(fingerprint.ok, true, fingerprint.error)
  const exported = await exportWorktreePatch(f.candidate)
  assert.equal(exported.ok, true, exported.error)
  assert.match(exported.patch, /after   /)
  await captureAcceptanceCandidate(f.repo)
  assert.equal(await exists(marker), false, "read-only host inspections must not execute repository programs")
  const task = { id: "controlled-promotion", status: "completed", payload: { cwd: f.repo }, result: { worktree_preserved: true, worktree_path: f.candidate } }
  await writePromotionJson(backgroundTaskCheckpointPath(task.id), task)
  const outcome = await applyWorktreeResult(task, { keepWorktree: true })
  assert.equal(outcome.ok, true, outcome.error)
  assert.equal(await readFile(path.join(f.repo, "app.txt"), "utf8"), "after   \n")
  assert.equal(await exists(marker), false, "actual snapshot/apply/retention must not execute repository programs")

  // Positive control proves the configured canary really executes in an
  // ordinary explicit Git operation; controlled mode is scoped, not global.
  f.git("config", "--unset", "filter.probe.process")
  f.git("-c", "core.fsmonitor=false", "add", "app.txt")
  assert.equal(await exists(marker), true)
})

test("controlled Git does not inherit ambient config injection or arbitrary extra environment", async t => {
  const f = await fixture(t)
  const saved = Object.fromEntries(["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"].map(key => [key, process.env[key]]))
  process.env.GIT_CONFIG_COUNT = "1"; process.env.GIT_CONFIG_KEY_0 = "user.email"; process.env.GIT_CONFIG_VALUE_0 = "synthetic-private-identity"
  process.env.GIT_CONFIG_GLOBAL = "\\\\.\\nul"; process.env.GIT_CONFIG_SYSTEM = path.join(root, "missing-parent", "unapproved-config")
  try {
    const result = await runControlledGit(["config", "--get", "user.email"], { cwd: f.repo })
    assert.equal(result.ok, true, result.stderr)
    assert.equal(result.stdout.trim(), "test@example.invalid")
    const denied = await runControlledGit(["status", "--porcelain"], { cwd: f.repo, env: { NODE_OPTIONS: "--import ./malicious.mjs" } })
    assert.equal(denied.ok, false)
    assert.match(denied.stderr, /arbitrary environment/)
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})
