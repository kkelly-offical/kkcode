import test from "node:test"
import assert from "node:assert/strict"
import { renderInstalledCommandSurface, describeReloadSummary } from "../src/repl/command-surface.mjs"

test("renderInstalledCommandSurface renders empty state", () => {
  assert.deepEqual(renderInstalledCommandSurface(), ["no custom commands or skills found"])
})

test("renderInstalledCommandSurface renders commands and non-template skills", () => {
  const lines = renderInstalledCommandSurface({
    customCommands: [{ name: "ship", scope: "project", source: ".kkcode/commands/ship.md" }],
    skills: [
      { name: "review", type: "skill_md", scope: "project" },
      { name: "init", type: "template", scope: "project" }
    ]
  })
  assert.deepEqual(lines, [
    "custom commands:",
    "  /ship (project) -> .kkcode/commands/ship.md",
    "skills:",
    "  /review (skill_md, project)"
  ])
})

test("describeReloadSummary formats counts", () => {
  assert.equal(
    describeReloadSummary({ commandCount: 2, skillCount: 5, agentCount: 1 }),
    "reloaded commands: 2, skills: 5, agents: 1"
  )
})
