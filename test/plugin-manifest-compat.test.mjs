import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { discoverLocalPluginManifests } from "../src/plugin/manifest-loader.mjs"

let homeDir
let projectDir

test.beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), "kkcode-plugin-home-"))
  projectDir = await mkdtemp(path.join(tmpdir(), "kkcode-plugin-project-"))
  process.env.KKCODE_HOME = homeDir
})

test.afterEach(async () => {
  delete process.env.KKCODE_HOME
  await rm(homeDir, { recursive: true, force: true })
  await rm(projectDir, { recursive: true, force: true })
})

test("discoverLocalPluginManifests supports both local package shapes", async () => {
  const singleRoot = path.join(projectDir, ".kkcode-plugin")
  const namedRoot = path.join(projectDir, ".kkcode", "plugins", "named-plugin")
  await mkdir(path.join(singleRoot, "skills"), { recursive: true })
  await mkdir(path.join(namedRoot, "hooks"), { recursive: true })

  await writeFile(path.join(singleRoot, "plugin.json"), JSON.stringify({
    name: "single-package",
    skills: ["skills"]
  }, null, 2))
  await writeFile(path.join(namedRoot, "plugin.json"), JSON.stringify({
    name: "named-plugin",
    hooks: ["hooks"]
  }, null, 2))

  const result = await discoverLocalPluginManifests(projectDir)
  const names = result.plugins.map((plugin) => plugin.name).sort()

  assert.deepEqual(names, ["named-plugin", "single-package"])
  assert.equal(result.errors.length, 0)
})

test("plugin manifest parser keeps malformed entries actionable", async () => {
  const root = path.join(projectDir, ".kkcode-plugin")
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, "plugin.json"), JSON.stringify({
    name: "broken-plugin",
    hooks: ["../escape"],
    mcp: [{ path: "../outside.json" }, 42]
  }, null, 2))

  const result = await discoverLocalPluginManifests(projectDir)

  assert.equal(result.plugins.length, 1)
  assert.ok(result.errors.some((item) => item.includes("points outside plugin root")))
  assert.ok(result.errors.some((item) => item.includes("mcp entries must be strings or objects")))
})
