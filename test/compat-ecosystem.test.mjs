import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { discoverLocalPluginManifests, pluginMcpServers } from "../src/plugin/manifest-loader.mjs"
import { SkillRegistry } from "../src/skill/registry.mjs"

let homeDir
let projectDir
let oldHome

test.beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), "kkcode-compat-home-"))
  projectDir = await mkdtemp(path.join(tmpdir(), "kkcode-compat-project-"))
  oldHome = process.env.HOME
  process.env.HOME = homeDir
  process.env.KKCODE_HOME = path.join(homeDir, ".kkcode")
  await mkdir(path.join(projectDir, ".git"), { recursive: true })
})

test.afterEach(async () => {
  if (oldHome === undefined) delete process.env.HOME
  else process.env.HOME = oldHome
  delete process.env.KKCODE_HOME
  await rm(homeDir, { recursive: true, force: true })
  await rm(projectDir, { recursive: true, force: true })
})

async function writeSkill(root, name, body = "Args: $ARGUMENTS") {
  const dir = path.join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}`)
}

test("SkillRegistry discovers Claude, Codex, and OpenCode SKILL.md roots", async () => {
  await writeSkill(path.join(projectDir, ".claude", "skills"), "claude-review", "Dir: ${CLAUDE_SKILL_DIR}")
  await writeSkill(path.join(projectDir, ".agents", "skills"), "codex-review")
  await writeSkill(path.join(projectDir, ".opencode", "skills"), "opencode-review")

  await SkillRegistry.initialize({ skills: { auto_seed: false }, mcp: { auto_discover: false } }, projectDir)

  assert.equal(SkillRegistry.get("claude-review")?.sourceEcosystem, "claude")
  assert.equal(SkillRegistry.get("codex-review")?.sourceEcosystem, "codex")
  assert.equal(SkillRegistry.get("opencode-review")?.sourceEcosystem, "opencode")

  const prompt = await SkillRegistry.execute("claude-review", "", { cwd: projectDir })
  assert.ok(prompt.includes(path.join(projectDir, ".claude", "skills", "claude-review")))
})

test("Claude and Codex plugin manifests load portable skills with plugin namespace", async () => {
  const claudeRoot = projectDir
  await mkdir(path.join(claudeRoot, ".claude-plugin"), { recursive: true })
  await writeFile(path.join(claudeRoot, ".claude-plugin", "plugin.json"), JSON.stringify({
    name: "claude-pack",
    version: "1.0.0",
    monitors: ["monitors/monitors.json"]
  }, null, 2))
  await writeSkill(path.join(claudeRoot, "skills"), "shared-review")

  const codexRoot = path.join(projectDir, "packages", "api")
  await mkdir(path.join(codexRoot, ".codex-plugin"), { recursive: true })
  await mkdir(path.join(codexRoot, "skills", "codex-helper"), { recursive: true })
  await writeFile(path.join(codexRoot, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "codex-pack",
    version: "0.2.0",
    skills: "./skills",
    mcpServers: "./.mcp.json",
    apps: "./apps"
  }, null, 2))
  await writeFile(path.join(codexRoot, ".mcp.json"), JSON.stringify({
    mcp_servers: {
      docs: { command: "docs-mcp", args: ["--stdio"] }
    }
  }, null, 2))
  await writeFile(path.join(codexRoot, "skills", "codex-helper", "SKILL.md"), "---\nname: helper\ndescription: helper skill\n---\nHelp")

  const manifests = await discoverLocalPluginManifests(codexRoot)
  assert.ok(manifests.errors.some((item) => item.includes("unsupported_component monitors")))
  assert.ok(manifests.errors.some((item) => item.includes("unsupported_component apps")))
  assert.ok(manifests.plugins.some((plugin) => plugin.name === "claude-pack" && plugin.sourceEcosystem === "claude"))
  assert.ok(manifests.plugins.some((plugin) => plugin.name === "codex-pack" && plugin.sourceEcosystem === "codex"))
  assert.ok(pluginMcpServers(manifests.plugins)["codex-pack/docs"])

  await SkillRegistry.initialize({ skills: { auto_seed: false }, mcp: { auto_discover: false } }, codexRoot)
  assert.ok(SkillRegistry.get("claude-pack:shared-review"))
  assert.ok(SkillRegistry.get("codex-pack:helper"))
})

test("OpenCode plugin files are diagnosed but not executed", async () => {
  const pluginDir = path.join(projectDir, ".opencode", "plugins")
  await mkdir(pluginDir, { recursive: true })
  await writeFile(path.join(pluginDir, "notify.ts"), "export const Notify = async () => ({})")

  const manifests = await discoverLocalPluginManifests(projectDir)
  assert.ok(manifests.plugins.some((plugin) => plugin.name === "notify" && plugin.sourceEcosystem === "opencode" && plugin.enabled === false))
  assert.ok(manifests.errors.some((item) => item.includes("opencode plugin files are discovered but not executed")))
})
