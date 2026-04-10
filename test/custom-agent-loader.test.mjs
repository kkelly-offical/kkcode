import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CustomAgentRegistry } from "../src/agent/custom-agent-loader.mjs"

let home = ""
let project = ""
let oldCwd = process.cwd()

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kkcode-agent-home-"))
  project = await mkdtemp(join(tmpdir(), "kkcode-agent-project-"))
  oldCwd = process.cwd()
  process.env.KKCODE_HOME = home
  process.chdir(project)
})

afterEach(async () => {
  process.chdir(oldCwd)
  delete process.env.KKCODE_HOME
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

test("custom agent loader reads markdown frontmatter and ignores extra compatibility metadata", async () => {
  const agentsDir = join(project, ".kkcode", "agents")
  await mkdir(agentsDir, { recursive: true })
  await writeFile(
    join(agentsDir, "portable-agent.md"),
    `---
name: portable-agent
description: Portable agent fixture
mode: subagent
permission: readonly
tools:
  - read
  - grep
maxTurns: 7
model: inherit
effort: medium
paths:
  - src/**
---
Inspect the owned files and report concise findings.
`,
    "utf8"
  )

  await CustomAgentRegistry.initialize(project)
  const agent = CustomAgentRegistry.get("portable-agent")
  assert.ok(agent)
  assert.equal(agent.description, "Portable agent fixture")
  assert.equal(agent.mode, "subagent")
  assert.equal(agent.permission, "readonly")
  assert.deepEqual(agent.tools, ["read", "grep"])
  assert.equal(agent.maxTurns, 7)
  assert.equal(agent.model, "inherit")
  assert.match(agent.prompt, /Inspect the owned files/)
})
