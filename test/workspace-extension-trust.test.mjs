import test, { afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ToolRegistry } from "../src/tool/registry.mjs"
import { SkillRegistry } from "../src/skill/registry.mjs"
import { HookBus, initHookBus } from "../src/plugin/hook-bus.mjs"
import { McpRegistry } from "../src/mcp/registry.mjs"

let workspace
let userHome

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function markerModule(marker, exported) {
  return [
    'import { writeFile } from "node:fs/promises"',
    `await writeFile(${JSON.stringify(marker)}, "loaded", "utf8")`,
    exported,
    ""
  ].join("\n")
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "kkcode-extension-project-"))
  userHome = await mkdtemp(path.join(os.tmpdir(), "kkcode-extension-home-"))
  process.env.KKCODE_HOME = userHome
})

afterEach(async () => {
  await McpRegistry.shutdown()
  delete process.env.KKCODE_HOME
  await rm(workspace, { recursive: true, force: true })
  await rm(userHome, { recursive: true, force: true })
})

test("untrusted extension initialization executes user modules but not project tools, skills, or hooks", async () => {
  const projectToolDir = path.join(workspace, ".kkcode", "tools")
  const projectSkillDir = path.join(workspace, ".kkcode", "skills")
  const projectHookDir = path.join(workspace, ".kkcode", "hooks")
  const userToolDir = path.join(userHome, "tools")
  const userSkillDir = path.join(userHome, "skills")
  const userHookDir = path.join(userHome, "hooks")
  await Promise.all([
    mkdir(projectToolDir, { recursive: true }),
    mkdir(projectSkillDir, { recursive: true }),
    mkdir(projectHookDir, { recursive: true }),
    mkdir(userToolDir, { recursive: true }),
    mkdir(userSkillDir, { recursive: true }),
    mkdir(userHookDir, { recursive: true })
  ])

  const markers = {
    projectTool: path.join(workspace, "project-tool.loaded"),
    projectSkill: path.join(workspace, "project-skill.loaded"),
    projectHook: path.join(workspace, "project-hook.loaded"),
    userTool: path.join(userHome, "user-tool.loaded"),
    userSkill: path.join(userHome, "user-skill.loaded"),
    userHook: path.join(userHome, "user-hook.loaded")
  }
  await Promise.all([
    writeFile(path.join(projectToolDir, "project.mjs"), markerModule(
      markers.projectTool,
      'export default { name: "project-tool", async execute() { return "project" } }'
    )),
    writeFile(path.join(userToolDir, "user.mjs"), markerModule(
      markers.userTool,
      'export default { name: "user-tool", async execute() { return "user" } }'
    )),
    writeFile(path.join(projectSkillDir, "project.mjs"), markerModule(
      markers.projectSkill,
      'export const name = "project-skill"; export async function run() { return "project" }'
    )),
    writeFile(path.join(userSkillDir, "user.mjs"), markerModule(
      markers.userSkill,
      'export const name = "user-skill"; export async function run() { return "user" }'
    )),
    writeFile(path.join(projectHookDir, "project.mjs"), markerModule(
      markers.projectHook,
      'export default { name: "project-hook", chat: {} }'
    )),
    writeFile(path.join(userHookDir, "user.mjs"), markerModule(
      markers.userHook,
      'export default { name: "user-hook", chat: {} }'
    ))
  ])

  await ToolRegistry.initialize({
    cwd: workspace,
    force: true,
    allowProjectSources: false,
    config: {
      tool: {
        sources: { builtin: false, local: true, plugin: false, mcp: false },
        local_dirs: [projectToolDir, userToolDir]
      }
    }
  })
  await SkillRegistry.initialize({
    skills: {
      enabled: true,
      auto_seed: false,
      dirs: [projectSkillDir, userSkillDir]
    },
    compat: { plugins: { enabled: false, ecosystems: ["kkcode"] } }
  }, workspace, { allowProjectSources: false })
  await initHookBus(workspace, {
    compat: { plugins: { enabled: false, ecosystems: ["kkcode"] } }
  }, { allowProjectSources: false, force: true })

  // Listing is a common hot path and must preserve the policy used by the
  // preceding initialization instead of silently restoring the default.
  await ToolRegistry.list({ mode: "agent", cwd: workspace })
  assert.ok(await exists(markers.userTool))
  assert.ok(await exists(markers.userSkill))
  assert.ok(await exists(markers.userHook))
  assert.equal(await exists(markers.projectTool), false)
  assert.equal(await exists(markers.projectSkill), false)
  assert.equal(await exists(markers.projectHook), false)
  assert.ok(await ToolRegistry.get("user-tool"))
  assert.equal(await ToolRegistry.get("project-tool"), null)
  assert.ok(SkillRegistry.get("user-skill"))
  assert.equal(SkillRegistry.get("project-skill"), null)
  assert.ok(HookBus.list().some((hook) => hook.name === "user-hook"))
  assert.equal(HookBus.list().some((hook) => hook.name === "project-hook"), false)
})

test("untrusted MCP discovery keeps user configuration and ignores project configuration", async () => {
  await writeFile(path.join(workspace, ".mcp.json"), JSON.stringify({
    mcpServers: {
      "project-server": { enabled: false, command: "project-command" }
    }
  }))
  await writeFile(path.join(userHome, "mcp.json"), JSON.stringify({
    mcpServers: {
      "user-server": { enabled: false, command: "user-command" }
    }
  }))

  await McpRegistry.initialize({
    runtime: { mcp_refresh_ttl_ms: 0 },
    mcp: {
      auto_discover: true,
      servers: { context7: { enabled: false } }
    },
    compat: { plugins: { enabled: false, ecosystems: ["kkcode"] } }
  }, {
    cwd: workspace,
    force: true,
    allowProjectSources: false
  })

  const names = McpRegistry.healthSnapshot().map((item) => item.name)
  assert.ok(names.includes("user-server"))
  assert.equal(names.includes("project-server"), false)
})
