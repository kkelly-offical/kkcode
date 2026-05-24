import test from "node:test"
import assert from "node:assert/strict"
import {
  buildSlashCatalog,
  buildSkillCatalog,
  slashQuery,
  skillQuery,
  slashSuggestions,
  applySuggestionToInput,
  normalizeSlashAlias
} from "../src/repl/slash-router.mjs"

test("buildSlashCatalog keeps slash commands separate from skills", () => {
  const catalog = buildSlashCatalog({
    builtinSlash: [{ name: "help", desc: "builtin" }],
    customCommands: [{ name: "deploy", scope: "project" }],
    skills: [{ name: "review", type: "skill_md" }, { name: "deploy", type: "mjs" }]
  })
  assert.deepEqual(catalog.map((item) => item.name), ["help", "deploy"])
})

test("buildSkillCatalog lists non-shadowed skills for dollar namespace", () => {
  const catalog = buildSkillCatalog({
    customCommands: [{ name: "deploy", scope: "project" }],
    skills: [{ name: "review", type: "skill_md" }, { name: "deploy", type: "mjs" }]
  })
  assert.deepEqual(catalog.map((item) => item.name), ["review"])
})

test("slashQuery extracts the first slash token", () => {
  assert.equal(slashQuery("/help"), "help")
  assert.equal(slashQuery("/help extra"), "help")
  assert.equal(slashQuery("$help"), null)
  assert.equal(slashQuery("plain text"), null)
})

test("skillQuery extracts the first dollar skill token", () => {
  assert.equal(skillQuery("$review"), "review")
  assert.equal(skillQuery("$review src"), "review")
  assert.equal(skillQuery("/review"), null)
  assert.equal(skillQuery("plain text"), null)
})

test("slashSuggestions ranks slash commands exact then prefix then includes", () => {
  const suggestions = slashSuggestions("/he", {
    builtinSlash: [{ name: "help" }, { name: "theme" }, { name: "shell" }],
    skills: [{ name: "health-check", type: "skill_md" }]
  })
  assert.deepEqual(suggestions.map((item) => item.name), ["help", "shell", "theme"])
})

test("slashSuggestions ranks dollar skills separately from slash commands", () => {
  const suggestions = slashSuggestions("$re", {
    builtinSlash: [{ name: "reload" }],
    skills: [{ name: "review" }, { name: "release-note" }]
  })
  assert.deepEqual(suggestions.map((item) => item.name), ["release-note", "review"])
  assert.ok(suggestions.every((item) => item.prefix === "$"))
})

test("applySuggestionToInput preserves trailing args and sigil", () => {
  assert.equal(applySuggestionToInput("/he", "help"), "/help ")
  assert.equal(applySuggestionToInput("/he foo bar", "help"), "/help foo bar")
  assert.equal(applySuggestionToInput("$re", "review"), "$review ")
  assert.equal(applySuggestionToInput("$re src", "review"), "$review src")
  assert.equal(applySuggestionToInput("plain", "help"), "plain")
})

test("normalizeSlashAlias expands known aliases", () => {
  assert.equal(normalizeSlashAlias("/h"), "/help")
  assert.equal(normalizeSlashAlias("/r"), "/resume")
  assert.equal(normalizeSlashAlias("/help"), "/help")
})
