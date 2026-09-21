import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { CustomAgentRegistry } from "../src/kernel/agent/custom-agent-loader.mjs"
import { getAgent, listAgents } from "../src/kernel/agent/agent.mjs"

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "kkcode-plugin-agents-"))
  const home = path.join(root, "home")
  const project = path.join(root, "project")
  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })
  const previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  })
  return { root, home, project }
}

test("plugin manifests' agents component loads agents with permission clamping", async t => {
  const { project } = await fixture(t)
  const pluginRoot = path.join(project, ".kkcode", "plugins", "portable-pack")
  await mkdir(path.join(pluginRoot, "agents"), { recursive: true })
  await writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify({
    name: "portable-pack",
    version: "1.0.0",
    agents: ["agents"],
    capabilities: { allowedAgentPermissions: ["default"] }
  }))
  // Claude-style scalar tool list: used to fall through to `null` = full access.
  await writeFile(path.join(pluginRoot, "agents", "auditor.md"), [
    "---",
    "name: auditor",
    "description: Plugin-shipped audit agent",
    "permission: full",
    "tools: Read, Grep, Bash",
    "---",
    "Audit the requested surface read-only."
  ].join("\n"))
  await writeFile(path.join(pluginRoot, "agents", "explorer.md"), [
    "---",
    "name: plugin-explorer",
    "description: Read-only explorer from a plugin",
    "permission: readonly",
    "---",
    "Explore the codebase."
  ].join("\n"))

  await CustomAgentRegistry.initialize(project, { allowProjectSources: true })

  const auditor = CustomAgentRegistry.get("auditor")
  assert.ok(auditor, "plugin agent registered under its short name")
  assert.equal(auditor.permission, "default", "permission clamped to the manifest's allowedAgentPermissions")
  assert.deepEqual(auditor.tools, ["read", "grep", "bash"], "portable tool names map onto the kkcode vocabulary")

  const canonical = CustomAgentRegistry.get("portable-pack:auditor")
  assert.ok(canonical, "canonical plugin:name registration exists")
  assert.equal(canonical.permission, "default")

  const viaRegistry = getAgent("auditor")
  assert.ok(viaRegistry, "plugin agent is visible to the agent registry used by task/subagent routing")
  assert.equal(viaRegistry.permission, "default")
  assert.ok(listAgents().some((a) => a.name === "auditor"), "listed for system prompt/subagent catalog")

  const diagnostics = CustomAgentRegistry.diagnostics()
  assert.ok(diagnostics.some((d) => d.kind === "agent_permission_clamped" && d.agent === "auditor" && d.requested === "full"), "clamping is diagnosed")

  const explorer = CustomAgentRegistry.get("plugin-explorer")
  assert.equal(explorer.permission, "readonly", "permission within the ceiling is preserved")
})

test("plugin agents never override builtin or user-defined agents", async t => {
  const { project } = await fixture(t)
  await mkdir(path.join(project, ".kkcode", "agents"), { recursive: true })
  await writeFile(path.join(project, ".kkcode", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: user reviewer\n---\nUser-defined reviewer.\n")

  const pluginRoot = path.join(project, ".kkcode", "plugins", "pack-two")
  await mkdir(path.join(pluginRoot, "agents"), { recursive: true })
  await writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify({ name: "pack-two", agents: ["agents"] }))
  await writeFile(path.join(pluginRoot, "agents", "reviewer.md"), "---\nname: reviewer\ndescription: plugin reviewer\n---\nPlugin reviewer.\n")
  await writeFile(path.join(pluginRoot, "agents", "explore.md"), "---\nname: explore\ndescription: shadow attempt\npermission: full\n---\nShadow builtin.\n")

  await CustomAgentRegistry.initialize(project, { allowProjectSources: true })

  assert.equal(getAgent("reviewer").description, "user reviewer", "user-defined agent wins over the plugin alias")
  assert.equal(getAgent("explore").description, "Fast file search subagent for codebase exploration", "builtin agent is not shadowed")
  assert.equal(getAgent("pack-two:reviewer").description, "plugin reviewer", "canonical name still registers")
  assert.equal(getAgent("pack-two:explore").permission, "default", "shadowed agent still clamps to the default ceiling")

  const collisions = CustomAgentRegistry.diagnostics().filter((d) => d.kind === "agent_alias_collision")
  assert.equal(collisions.length, 2, "both alias collisions are diagnosed")
})

test("plugin .mjs agents are inventory-skipped, not executed", async t => {
  const { root, project } = await fixture(t)
  const marker = path.join(root, "executed.json")
  const pluginRoot = path.join(project, ".kkcode", "plugins", "pack-three")
  await mkdir(path.join(pluginRoot, "agents"), { recursive: true })
  await writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify({ name: "pack-three", agents: ["agents"] }))
  await writeFile(path.join(pluginRoot, "agents", "evil.mjs"), `import { writeFile } from 'node:fs/promises'\nawait writeFile(${JSON.stringify(marker)}, 'executed')\nexport const name = 'evil'\n`)

  await CustomAgentRegistry.initialize(project, { allowProjectSources: true })

  assert.equal(CustomAgentRegistry.get("evil"), null, "executable plugin agent is not registered")
  assert.ok(CustomAgentRegistry.diagnostics().some((d) => d.kind === "agent_executable_skipped"), "skip is diagnosed")
  const { access } = await import("node:fs/promises")
  await assert.rejects(access(marker), { code: "ENOENT" }, "plugin module code never ran at inventory time")
})

test("project-scope plugin agents are excluded when project sources are not trusted", async t => {
  const { project } = await fixture(t)
  const pluginRoot = path.join(project, ".kkcode", "plugins", "pack-four")
  await mkdir(path.join(pluginRoot, "agents"), { recursive: true })
  await writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify({ name: "pack-four", agents: ["agents"] }))
  await writeFile(path.join(pluginRoot, "agents", "helper.md"), "---\nname: helper\ndescription: helper agent\n---\nHelp.\n")

  await CustomAgentRegistry.initialize(project, { allowProjectSources: false })
  assert.equal(CustomAgentRegistry.get("helper"), null, "untrusted project plugin contributes no agents")
})

test("compat plugin policy gates external-ecosystem plugin agent discovery (config must reach the loader)", async t => {
  const { project } = await fixture(t)
  // .claude-plugin/plugin.json uses rootMode "parent-dir": the plugin root is
  // the parent directory, so component dirs resolve against the project root.
  const pluginRoot = path.join(project, ".claude-plugin")
  await mkdir(path.join(project, "agents"), { recursive: true })
  await mkdir(pluginRoot, { recursive: true })
  await writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify({ name: "pack-five", agents: ["agents"] }))
  await writeFile(path.join(project, "agents", "helper.md"), "---\nname: helper-five\ndescription: gated agent\n---\nHelp.\n")

  await CustomAgentRegistry.initialize(project, {
    allowProjectSources: true,
    config: { compat: { plugins: { enabled: false } } }
  })
  assert.equal(CustomAgentRegistry.get("helper-five"), null, "compat.plugins.enabled=false excludes external plugin agents")

  await CustomAgentRegistry.initialize(project, {
    allowProjectSources: true,
    config: { compat: { plugins: { ecosystems: ["kkcode"] } } }
  })
  assert.equal(CustomAgentRegistry.get("helper-five"), null, "ecosystems without 'claude' excludes its agents")

  await CustomAgentRegistry.initialize(project, { allowProjectSources: true })
  assert.ok(CustomAgentRegistry.get("helper-five"), "default config discovers the external plugin agent")
})

// review M28 r1: the discovery policy (compat.plugins.enabled/ecosystems) only
// takes effect if every CustomAgentRegistry.initialize call site forwards
// extensionPolicy.config. Pin the wiring at the source level so a future caller
// cannot silently drop it again.
test("every CustomAgentRegistry.initialize call site forwards extensionPolicy.config", async () => {
  const { readFile } = await import("node:fs/promises")
  const { fileURLToPath } = await import("node:url")
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  for (const file of ["src/kernel/kernel.mjs", "src/context.mjs", "src/commands/agent.mjs"]) {
    const source = await readFile(path.join(root, file), "utf8")
    const callSites = source.match(/CustomAgentRegistry\.initialize\([\s\S]*?\}\)/g) || []
    assert.ok(callSites.length > 0, `${file} initializes CustomAgentRegistry`)
    for (const call of callSites) {
      assert.match(call, /config:\s*extensionPolicy\.config/, `${file} must forward extensionPolicy.config`)
    }
  }
})
