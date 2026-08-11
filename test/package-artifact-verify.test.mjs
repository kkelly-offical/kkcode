import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT = fileURLToPath(new URL("../scripts/package-artifact-verify.mjs", import.meta.url))

function npmPack(cwd) {
  const result = spawnSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", cwd],
    { cwd, shell: process.platform === "win32", encoding: "utf8" }
  )
  assert.equal(result.status, 0, result.stderr)
  return path.join(cwd, JSON.parse(result.stdout)[0].filename)
}

async function digest(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex")
}

function verifyArtifact(tarball, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: path.dirname(SCRIPT),
    env: { ...process.env, KKCODE_PACKAGE_TARBALL: tarball, ...extraEnv },
    encoding: "utf8"
  })
}

test("final artifact verification never executes the packaged entrypoint or changes the tarball", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-artifact-clean-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, "src"))
  const marker = path.join(dir, "entrypoint-executed")
  await writeFile(path.join(dir, "package.json"), JSON.stringify({
    name: "@kkelly-offical/kkcode",
    version: "0.9.2",
    type: "module",
    bin: { kkcode: "src/index.mjs" },
    files: ["src"]
  }))
  await writeFile(path.join(dir, "src", "index.mjs"), [
    'import { writeFileSync } from "node:fs"',
    'writeFileSync(process.env.KKCODE_ATTACK_MARKER, "executed")'
  ].join("\n"))

  const tarball = npmPack(dir)
  const before = await digest(tarball)
  const result = verifyArtifact(tarball, { KKCODE_ATTACK_MARKER: marker })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /immutable package verified/)
  assert.equal(await digest(tarball), before)
  await assert.rejects(readFile(marker), { code: "ENOENT" })
})

test("final artifact verification rejects a packaged secret without echoing it", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-artifact-secret-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, "dist"))
  const npmToken = ["npm", "_", "J".repeat(36)].join("")
  await writeFile(path.join(dir, "package.json"), JSON.stringify({
    name: "@kkelly-offical/kkcode",
    version: "0.9.2",
    files: ["dist"]
  }))
  await writeFile(path.join(dir, "dist", "leak.txt"), npmToken)

  const result = verifyArtifact(npmPack(dir))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /dist\/leak\.txt:1: possible npm access token/)
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(npmToken))
})
