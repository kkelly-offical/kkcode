import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile, lstat, rm, link, symlink } from "node:fs/promises"
import { createVerificationRunner } from "../src/kernel/isolation/verification-workspace.mjs"
import { captureAcceptanceCandidate, captureAcceptanceSources } from "../src/kernel/session/acceptance-manifest.mjs"

const exists = target => lstat(target).then(() => true, error => { if (error.code === "ENOENT") return false; throw error })
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kk-verification-copy-"))
  const cwd = path.join(root, "implementation")
  await mkdir(cwd)
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git("init"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test"); git("config", "core.autocrlf", "false")
  await mkdir(path.join(cwd, "test"))
  await writeFile(path.join(cwd, "app.mjs"), "export const version = 2\n")
  await writeFile(path.join(cwd, "test/check.mjs"), "// fixed host assertion\n")
  await writeFile(path.join(cwd, ".gitignore"), "node_modules/\ndist/\n")
  git("add", "."); git("commit", "-m", "sealed candidate")
  await mkdir(path.join(cwd, "node_modules"))
  await writeFile(path.join(cwd, "node_modules/unsealed.js"), "do not copy\n")
  const snapshots = [], bindings = []
  let implementation = async () => ({ ok: true, code: 0, stdout: "ok", stderr: "" })
  const createBackend = async ({ readOnlyPaths }) => {
    let target
    return {
      async ensureReady({ cwd }) {
        target = cwd
        snapshots.push(cwd); bindings.push(readOnlyPaths)
        return { strict: true, network: "none", imageId: `sha256:${"a".repeat(64)}` }
      },
      runCommand: request => implementation(request, target)
    }
  }
  const runner = createVerificationRunner({ cwd, createBackend, parent: path.join(root, "private-verifiers") })
  t.after(async () => { await runner.dispose().catch(() => {}); await rm(root, { recursive: true, force: true }) })
  const metadata = async (manifestId = "b".repeat(64)) => {
    const candidate = await captureAcceptanceCandidate(cwd)
    const sources = await captureAcceptanceSources({ cwd, paths: ["test/check.mjs"] })
    return { manifestId, boundaryId: "c".repeat(64), candidateHash: candidate.treeFingerprint,
      sourceFingerprint: sources.fingerprint, testSources: sources.files }
  }
  const run = async acceptance => runner.runCommand({ command: "node", args: ["test/check.mjs"], cwd, shell: false, acceptance: acceptance || await metadata() })
  return { root, cwd, git, runner, run, metadata, snapshots, bindings, setImplementation: fn => { implementation = fn } }
}

test("private verifier copies sealed files, not .git or ignored dependencies, and preserves build outputs between commands", async t => {
  const f = await fixture(t)
  let count = 0
  f.setImplementation(async (request, snapshot) => {
    assert.equal(request.cwd, snapshot)
    assert.notEqual(snapshot, f.cwd)
    assert.equal(await exists(path.join(snapshot, ".git")), false)
    assert.equal(await exists(path.join(snapshot, "node_modules")), false)
    if (++count === 1) {
      await mkdir(path.join(snapshot, "dist"))
      await writeFile(path.join(snapshot, "dist/build.txt"), "built\n")
    } else assert.equal(await readFile(path.join(snapshot, "dist/build.txt"), "utf8"), "built\n")
    return { ok: true, code: 0 }
  })
  await f.run(); await f.run()
  assert.equal(f.snapshots.length, 1)
  assert.deepEqual(f.bindings[0].sort(), [".gitignore", "app.mjs", "test/check.mjs"])
  assert.equal(await exists(path.join(f.cwd, "dist")), false)
  await f.runner.dispose()
  assert.equal(await exists(f.snapshots[0]), false)
})

test("modifying any original candidate source in verifier invalidates a successful exit", async t => {
  const f = await fixture(t)
  f.setImplementation(async (_request, snapshot) => {
    await writeFile(path.join(snapshot, "app.mjs"), "weakened implementation\n")
    return { ok: true, code: 0 }
  })
  await assert.rejects(f.run(), /修改了已封存源文件/)
  assert.equal(await readFile(path.join(f.cwd, "app.mjs"), "utf8"), "export const version = 2\n")
})

test("modified frozen tests cannot pass and are never written back to implementation", async t => {
  const f = await fixture(t)
  f.setImplementation(async (_request, snapshot) => {
    await writeFile(path.join(snapshot, "test/check.mjs"), "return success\n")
    return { ok: true, code: 0 }
  })
  await assert.rejects(f.run(), /修改了已封存源文件/)
  assert.equal(await readFile(path.join(f.cwd, "test/check.mjs"), "utf8"), "// fixed host assertion\n")
})

test("original candidate changes before and during verification invalidate old receipts", async t => {
  const f = await fixture(t)
  const original = await f.metadata()
  await writeFile(path.join(f.cwd, "app.mjs"), "new candidate\n")
  await assert.rejects(f.run(original), /原候选已改变/)
  assert.equal(f.snapshots.length, 0)
  f.setImplementation(async () => {
    await writeFile(path.join(f.cwd, "app.mjs"), "changed while testing\n")
    return { ok: true, code: 0 }
  })
  await assert.rejects(f.run(), /原候选已改变/)
})

test("new manifest gets a new private workspace instead of carrying old outputs", async t => {
  const f = await fixture(t)
  await f.run()
  const first = f.snapshots[0]
  await f.run(await f.metadata("d".repeat(64)))
  assert.equal(f.snapshots.length, 2)
  assert.notEqual(f.snapshots[0], f.snapshots[1])
  assert.equal(await exists(first), false)
})

test("hardlinks and escaping symlinks are rejected before backend execution", async t => {
  const f = await fixture(t)
  await link(path.join(f.cwd, "app.mjs"), path.join(f.cwd, "linked.mjs"))
  await assert.rejects(f.run(), /硬链接/)
  assert.equal(f.snapshots.length, 0)
  await rm(path.join(f.cwd, "linked.mjs"))
  const outside = path.join(f.root, "outside.txt")
  await writeFile(outside, "outside\n")
  try { await symlink(outside, path.join(f.cwd, "escape")) }
  catch (error) { if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) return; throw error }
  await assert.rejects(f.run(), /符号链接越出/)
  assert.equal(f.snapshots.length, 0)
})

test("timeout still checks source integrity and cancellation never starts a verifier", async t => {
  const f = await fixture(t)
  f.setImplementation(async (_request, snapshot) => {
    await writeFile(path.join(snapshot, "app.mjs"), "broken\n")
    throw new Error("timed out")
  })
  await assert.rejects(f.run(), /修改了已封存源文件/)
  const controller = new AbortController(); controller.abort(new Error("cancelled"))
  const runner = createVerificationRunner({ cwd: f.cwd, signal: controller.signal, createBackend: () => { throw new Error("must not start") } })
  await assert.rejects(runner.runCommand({ cwd: f.cwd, shell: false, acceptance: await f.metadata() }), /cancelled/)
  await runner.dispose()
})

test("missing metadata and forged source fingerprints never fall back to implementation executor", async t => {
  const f = await fixture(t)
  await assert.rejects(f.runner.runCommand({ command: "node", args: [], cwd: f.cwd, shell: false }), /缺少宿主封存/)
  const bad = { ...await f.metadata(), sourceFingerprint: "0".repeat(64) }
  await assert.rejects(f.run(bad), /原始验收来源指纹/)
  assert.equal(f.snapshots.length, 0)
})

test("real Docker verifies a private copy with immutable sources and writable new outputs", { skip: !process.env.KKCODE_TEST_DOCKER_IMAGE }, async t => {
  const f = await fixture(t)
  const { createDockerExecutionBackend } = await import("../src/kernel/isolation/docker-executor.mjs")
  const backend = createDockerExecutionBackend({ image: process.env.KKCODE_TEST_DOCKER_IMAGE })
  await backend.ensureReady({ cwd: f.cwd, contract: { allowedPaths: ["."] } })
  const runner = createVerificationRunner({ cwd: f.cwd, parent: path.join(f.root, "real-docker-verifiers"),
    createBackend: options => backend.createVerificationBackend(options) })
  t.after(() => runner.dispose())
  const script = [
    "const fs=require('node:fs');",
    "if(fs.existsSync('.git')||fs.existsSync('node_modules')) throw Error('unsealed state leaked');",
    "let denied=0; for(const act of [()=>fs.writeFileSync('app.mjs','bad'),()=>fs.writeFileSync('test/check.mjs','bad'),()=>fs.renameSync('test','moved')]){try{act()}catch{denied++}}",
    "if(denied!==3)throw Error('immutable source mount bypass');",
    "fs.mkdirSync('dist');fs.writeFileSync('dist/built.txt','verified');",
    "if(process.env.GITHUB_TOKEN||process.env.NPM_TOKEN)throw Error('credential leak');",
    "console.log('independent-verifier-ok')"
  ].join("")
  const result = await runner.runCommand({ command: "node", args: ["-e", script], shell: false, cwd: f.cwd, acceptance: await f.metadata() })
  assert.equal(result.ok, true, result.stderr)
  assert.match(result.stdout, /independent-verifier-ok/)
  assert.equal(result.isolation.network, "none")
  assert.equal(await exists(path.join(f.cwd, "dist")), false)
  const next = await runner.runCommand({ command: "node", args: ["-e", "if(require('fs').readFileSync('dist/built.txt','utf8')!=='verified')process.exit(1)"],
    shell: false, cwd: f.cwd, acceptance: await f.metadata() })
  assert.equal(next.ok, true, next.stderr)
})
