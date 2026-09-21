import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { SkillRegistry } from "../src/kernel/skill/registry.mjs"
import { createToolRegistry } from "../src/kernel/tool/registry.mjs"

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "kkcode-skill-invoke-"))
  const home = path.join(root, "home")
  const project = path.join(root, "project")
  await mkdir(home, { recursive: true })
  await mkdir(path.join(project, ".kkcode", "skills"), { recursive: true })
  const previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  })
  return { root, project }
}

async function skillTool(project) {
  await SkillRegistry.initialize({ skills: { auto_seed: false }, mcp: { auto_discover: false }, compat: { plugins: { ecosystems: ["kkcode"] } } }, project)
  const registry = createToolRegistry({ mcpRegistry: { initialize: async () => {}, listTools: () => [] } })
  await registry.initialize({ config: { tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } } }, cwd: project, allowProjectSources: false })
  return registry.get("skill")
}

test("disable-model-invocation skills are hidden from the listing AND refused at the tool boundary", async t => {
  const { project } = await fixture(t)
  await mkdir(path.join(project, ".kkcode", "skills", "hidden-skill"), { recursive: true })
  await mkdir(path.join(project, ".kkcode", "skills", "open-skill"), { recursive: true })
  await writeFile(path.join(project, ".kkcode", "skills", "hidden-skill", "SKILL.md"), "---\nname: hidden-skill\ndescription: user-only skill\ndisable-model-invocation: true\n---\nbody for $ARGUMENTS\n")
  await writeFile(path.join(project, ".kkcode", "skills", "open-skill", "SKILL.md"), "---\nname: open-skill\ndescription: model-callable skill\n---\nopen body $ARGUMENTS\n")

  const tool = await skillTool(project)

  const listing = SkillRegistry.listForSystemPrompt().map((skill) => skill.name)
  assert.ok(!listing.includes("hidden-skill"), "hidden from the model-facing listing")
  assert.ok(listing.includes("open-skill"), "normal skills stay listed")

  const refused = await tool.execute({ skill: "hidden-skill", args: "x" }, { cwd: project })
  assert.match(String(refused), /not model-invocable/)
  assert.match(String(refused), /\$hidden-skill/, "points at the user invocation path")

  const allowed = await tool.execute({ skill: "open-skill", args: "hello" }, { cwd: project })
  assert.match(String(allowed), /open body hello/)
})

test("allowed-tools is parsed, carried, and labeled accepted-not-enforced in diagnostics", async t => {
  const { project } = await fixture(t)
  await mkdir(path.join(project, ".kkcode", "skills", "bounded-skill"), { recursive: true })
  await writeFile(path.join(project, ".kkcode", "skills", "bounded-skill", "SKILL.md"), "---\nname: bounded-skill\ndescription: bounded\nallowed-tools: read grep\n---\nbounded body\n")
  await skillTool(project)

  const skill = SkillRegistry.get("bounded-skill")
  assert.deepEqual(skill.allowedTools, ["read", "grep"], "frontmatter parses (space-separated Agent Skills form)")

  const diagnostics = SkillRegistry.diagnostics()
  assert.ok(
    diagnostics.some((d) => d.kind === "skill_allowed_tools_accepted_not_enforced" && d.name === "bounded-skill"),
    "the support level is labeled instead of silently pretending enforcement"
  )
})
