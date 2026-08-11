import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  findSecretsInText,
  npmPackFiles,
  npmPackInvocation,
  parseNpmPackManifest,
  scanDirectoryTree
} from "../scripts/secret-scan.mjs"

const SCRIPT = fileURLToPath(new URL("../scripts/secret-scan.mjs", import.meta.url))

test("secret patterns include npm publishing credentials without matching their own source", async () => {
  const npmToken = ["npm", "_", "A".repeat(36)].join("")
  assert.deepEqual(findSecretsInText(npmToken).map((finding) => finding.label), ["npm access token"])

  const source = await readFile(SCRIPT, "utf8")
  assert.deepEqual(findSecretsInText(source), [], "正则源码本身不应让发布门槛永久自锁")
})

test("npm pack uses the JavaScript CLI or a controlled cmd.exe fallback on Windows", () => {
  assert.deepEqual(npmPackInvocation({
    platform: "win32",
    env: { npm_execpath: "C:\\node\\npm-cli.js", ComSpec: "C:\\Windows\\cmd.exe" },
    execPath: "C:\\node\\node.exe"
  }), {
    command: "C:\\node\\node.exe",
    args: ["C:\\node\\npm-cli.js", "pack", "--dry-run", "--json", "--ignore-scripts"]
  })

  const fallback = npmPackInvocation({
    platform: "win32",
    env: { ComSpec: "C:\\Windows\\cmd.exe" },
    execPath: "C:\\node\\node.exe"
  })
  assert.equal(fallback.command, "C:\\Windows\\cmd.exe")
  assert.deepEqual(fallback.args.slice(0, 3), ["/d", "/s", "/c"])
  assert.match(fallback.args[3], /^npm\.cmd pack /)
})

test("npm pack manifest parsing fails closed on malformed or empty output", async (t) => {
  for (const output of ["{}", "[]", '[{"files":[]}]', '[{"files":[{}]}]']) {
    assert.throws(() => parseNpmPackManifest(output), { code: "INVALID_PACK_MANIFEST" })
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-secret-manifest-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}')
  const result = npmPackFiles(dir, {
    platform: "linux",
    env: {},
    execFileSync: () => "[]"
  })
  assert.equal(result.error, "INVALID_PACK_MANIFEST")
  assert.deepEqual(result.files, [])
})

test("unpacked package scanning covers payload-only files and sanitizes paths", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-secret-tree-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, "dist"))
  const npmToken = ["npm", "_", "I".repeat(36)].join("")
  await writeFile(path.join(dir, "dist", "payload.js"), npmToken)
  await writeFile(path.join(dir, `\u061c${npmToken}.txt`), "clean\n")

  const result = scanDirectoryTree(dir)
  assert.equal(result.scanned, 2)
  assert.ok(result.findings.some((finding) => /dist\/payload\.js:1: possible npm access token/.test(finding)))
  assert.ok(result.findings.some((finding) => /\\u061c<redacted>\.txt: possible npm access token in filename/.test(finding)))
  assert.doesNotMatch(result.findings.join("\n"), new RegExp(npmToken))
})

test("CLI scans NUL-delimited tracked names and exits non-zero without printing the secret", {
  skip: process.platform === "win32"
}, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-secret-scan-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" })

  const unusualName = "line\nbreak.txt"
  const npmToken = ["npm", "_", "B".repeat(36)].join("")
  await writeFile(path.join(dir, unusualName), `credential=${npmToken}\n`)
  execFileSync("git", ["add", "--", unusualName], { cwd: dir })

  const result = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /possible npm access token/)
  assert.doesNotMatch(result.stderr, new RegExp(npmToken), "扫描器只报位置，绝不回显凭据")
})

test("CLI scans package-lock.json instead of treating lockfiles as trusted", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-secret-lock-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" })
  const npmToken = ["npm", "_", "C".repeat(36)].join("")
  await writeFile(path.join(dir, "package-lock.json"), JSON.stringify({ token: npmToken }))

  const result = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /package-lock\.json:1: possible npm access token/)
  assert.doesNotMatch(result.stderr, new RegExp(npmToken))
})

test("CLI scans files selected by npm pack even when Git ignores them", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-secret-pack-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" })
  await writeFile(path.join(dir, "package.json"), JSON.stringify({
    name: "secret-pack-fixture", version: "1.0.0", files: ["dist"]
  }))
  await writeFile(path.join(dir, ".gitignore"), "dist/\n")
  await mkdir(path.join(dir, "dist"))
  const npmToken = ["npm", "_", "F".repeat(36)].join("")
  await writeFile(path.join(dir, "dist", "secret.js"), `export default ${JSON.stringify(npmToken)}\n`)
  execFileSync("git", ["add", "package.json", ".gitignore"], { cwd: dir })

  const result = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /dist[\\/]secret\.js:1: possible npm access token/)
  assert.doesNotMatch(result.stderr, new RegExp(npmToken))
})

test("CLI scans the staged blob even when the worktree copy has already been cleaned", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-secret-index-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" })
  const npmToken = ["npm", "_", "D".repeat(36)].join("")
  const target = path.join(dir, "staged.txt")
  await writeFile(target, `${npmToken}\n`)
  execFileSync("git", ["add", "staged.txt"], { cwd: dir })
  await writeFile(target, "clean worktree\n")

  const result = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /staged\.txt \[index\]:1: possible npm access token/)
  assert.doesNotMatch(result.stderr, new RegExp(npmToken))
})

test("CLI fails closed for an ordinary tracked file missing from the worktree", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-secret-missing-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" })
  const target = path.join(dir, "deleted.txt")
  await writeFile(target, "clean\n")
  execFileSync("git", ["add", "deleted.txt"], { cwd: dir })
  await unlink(target)

  const result = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /deleted\.txt: possible unreadable file \(ENOENT\)/)
})

test("CLI escapes terminal control characters in reported Git paths", {
  skip: process.platform === "win32"
}, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-secret-path-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" })
  const unusualName = `alert-\u001b[2J-\u009b-\u061c-\u200e-\u2028-\u202e.txt`
  const npmToken = ["npm", "_", "E".repeat(36)].join("")
  await writeFile(path.join(dir, unusualName), npmToken)

  const result = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" })
  assert.equal(result.status, 1)
  assert.doesNotMatch(result.stderr, /\u001b/, "stderr 不得包含原始 ESC 控制字符")
  assert.match(result.stderr, /\\u001b\[2J/)
  assert.doesNotMatch(result.stderr, /[\u009b\u061c\u200e\u2028\u202e]/u, "C1、分行与 bidi controls 不得原样输出")
  assert.match(result.stderr, /\\u009b/)
  assert.match(result.stderr, /\\u061c/)
  assert.match(result.stderr, /\\u200e/)
  assert.match(result.stderr, /\\u2028/)
  assert.match(result.stderr, /\\u202e/)
})

test("CLI detects and redacts credentials embedded in filenames", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-secret-filename-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" })
  const npmToken = ["npm", "_", "G".repeat(36)].join("")
  await writeFile(path.join(dir, `${npmToken}.txt`), "clean\n")

  const result = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /<redacted>\.txt: possible npm access token in filename/)
  assert.doesNotMatch(result.stderr, new RegExp(npmToken))
})

test("CLI skips gitlink directories while still succeeding on a clean repository", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-secret-gitlink-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir })
  await writeFile(path.join(dir, "README.md"), "clean\n")
  execFileSync("git", ["add", "README.md"], { cwd: dir })
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" })
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim()
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${commit},sub`], { cwd: dir })
  await mkdir(path.join(dir, "sub"))

  const result = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /secret scan ok/)
})

test("CLI scans a gitlink directory when npm pack includes its contents", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-secret-gitlink-pack-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir })
  await writeFile(path.join(dir, "package.json"), JSON.stringify({
    name: "gitlink-pack-fixture", version: "1.0.0", files: ["sub"]
  }))
  execFileSync("git", ["add", "package.json"], { cwd: dir })
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" })
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim()
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${commit},sub`], { cwd: dir })
  await mkdir(path.join(dir, "sub"))
  const npmToken = ["npm", "_", "H".repeat(36)].join("")
  await writeFile(path.join(dir, "sub", "secret.js"), npmToken)

  const result = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /sub[\\/]secret\.js:1: possible npm access token/)
  assert.doesNotMatch(result.stderr, new RegExp(npmToken))
})

test("CLI still runs when invoked through a symlink", {
  skip: process.platform === "win32"
}, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-secret-symlink-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" })
  const link = path.join(dir, "secret-scan-link.mjs")
  await symlink(SCRIPT, link)

  const result = spawnSync(process.execPath, [link], { cwd: dir, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /secret scan ok/)
})
