import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { discoverLocalPluginManifests } from "../src/plugin/manifest-loader.mjs"
import { SkillRegistry } from "../src/skill/registry.mjs"

let homeDir
let projectDir

test.beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), "kkcode-skill-home-"))
  projectDir = await mkdtemp(path.join(tmpdir(), "kkcode-skill-project-"))
  process.env.KKCODE_HOME = homeDir
})

test.afterEach(async () => {
  delete process.env.KKCODE_HOME
  await rm(homeDir, { recursive: true, force: true })
  await rm(projectDir, { recursive: true, force: true })
})

test("discoverLocalPluginManifests loads local plugin manifest and keeps trust boundaries explicit", async () => {
  const pluginRoot = path.join(projectDir, ".kkcode", "plugins", "demo-plugin")
  await mkdir(path.join(pluginRoot, "skills"), { recursive: true })
  await writeFile(path.join(pluginRoot, "mcp.json"), JSON.stringify({
    servers: {
      demo: { transport: "stdio", command: ["node", "server.js"] }
    }
  }))
  await writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify({
    name: "demo-plugin",
    version: "1.0.0",
    components: {
      skills: ["skills"],
      agents: ["agents"],
      hooks: ["hooks"]
    },
    capabilities: {
      allowedAgentPermissions: ["default"]
    },
    mcp: ["mcp.json"]
  }, null, 2))

  const result = await discoverLocalPluginManifests(projectDir)
  assert.equal(result.errors.length, 0)
  assert.equal(result.plugins.length, 1)
  assert.equal(result.plugins[0].name, "demo-plugin")
  assert.equal(result.plugins[0].scope, "project")
  assert.deepEqual(result.plugins[0].capabilities.allowedAgentPermissions, ["default"])
  assert.equal(result.plugins[0].skills[0], path.join(pluginRoot, "skills"))
  assert.equal(result.plugins[0].agents[0], path.join(pluginRoot, "agents"))
  assert.equal(result.plugins[0].hooks[0], path.join(pluginRoot, "hooks"))
  assert.ok(result.plugins[0].mcpServers.demo)
})

test("discoverLocalPluginManifests reports traversal attempts", async () => {
  const pluginRoot = path.join(projectDir, ".kkcode-plugin")
  await mkdir(pluginRoot, { recursive: true })
  await writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify({
    name: "bad-plugin",
    skills: ["../escape"]
  }, null, 2))

  const result = await discoverLocalPluginManifests(projectDir)
  assert.equal(result.plugins.length, 1)
  assert.equal(result.plugins[0].skills.length, 0)
  assert.ok(result.errors.some((item) => item.includes("points outside plugin root")))
})

test("SkillRegistry loads plugin-manifest skills with compatible frontmatter", async () => {
  const pluginRoot = path.join(projectDir, ".kkcode", "plugins", "compat-plugin")
  const skillDir = path.join(pluginRoot, "skills", "portable-review")
  await mkdir(skillDir, { recursive: true })
  await writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify({
    name: "compat-plugin",
    components: {
      skills: ["skills"]
    },
    capabilities: {
      allowedAgentPermissions: ["default"]
    }
  }, null, 2))
  await writeFile(path.join(skillDir, "SKILL.md"), `---
name: portable-review
description: Portable review helper
when_to_use: Use for imported review tasks
argument-hint: <target>
allowed-tools: [read, grep]
context: fork
model: inherit
agent: reviewer
effort: high
paths:
  - src/**
---
Skill root: \${SKILL_ROOT}
Name: \${SKILL_NAME}
Hint: \${ARGUMENT_HINT}
Use: \${WHEN_TO_USE}
Args: $ARGUMENTS
`)

  await SkillRegistry.initialize({ skills: { auto_seed: false }, mcp: { auto_discover: false } }, projectDir)
  const skill = SkillRegistry.get("portable-review")
  assert.ok(skill)
  assert.equal(skill.plugin?.name, "compat-plugin")
  assert.equal(skill.contextFork, true)
  assert.equal(skill.model, null)
  assert.deepEqual(skill.allowedTools, ["read", "grep"])
  assert.equal(skill.argumentHint, "<target>")
  assert.equal(skill.whenToUse, "Use for imported review tasks")
  assert.deepEqual(skill.paths, ["src/**"])

  const prompt = await SkillRegistry.execute("portable-review", "src/index.mjs", { cwd: projectDir })
  assert.equal(typeof prompt, "object")
  assert.equal(prompt.contextFork, true)
  assert.ok(prompt.prompt.includes(`Skill root: ${skillDir}`))
  assert.ok(prompt.prompt.includes("Name: portable-review"))
  assert.ok(prompt.prompt.includes("Hint: <target>"))
  assert.ok(prompt.prompt.includes("Use: Use for imported review tasks"))
  assert.ok(prompt.prompt.includes("Args: src/index.mjs"))

  const manifests = SkillRegistry.listPluginManifests()
  assert.equal(manifests.length, 1)
  assert.equal(manifests[0].name, "compat-plugin")
  assert.deepEqual(SkillRegistry.pluginErrors(), [])
})
