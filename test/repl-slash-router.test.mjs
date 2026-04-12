import test from "node:test"
import assert from "node:assert/strict"
import {
  buildSlashCatalog,
  slashQuery,
  slashSuggestions,
  applySuggestionToInput,
  normalizeSlashAlias
} from "../src/repl/slash-router.mjs"

test("buildSlashCatalog merges builtin, custom, and unique skills", () => {
  const catalog = buildSlashCatalog({
    builtinSlash: [{ name: "help", desc: "builtin" }],
    customCommands: [{ name: "deploy", scope: "project" }],
    skills: [{ name: "review", type: "skill_md" }, { name: "deploy", type: "mjs" }]
  })
  assert.deepEqual(catalog.map((item) => item.name), ["help", "deploy", "review"])
})

test("slashQuery extracts the first slash token", () => {
  assert.equal(slashQuery("/help"), "help")
  assert.equal(slashQuery("/help extra"), "help")
  assert.equal(slashQuery("plain text"), null)
})

test("slashSuggestions ranks exact then prefix then includes", () => {
  const suggestions = slashSuggestions("/he", {
    builtinSlash: [{ name: "help" }, { name: "theme" }, { name: "shell" }]
  })
  assert.deepEqual(suggestions.map((item) => item.name), ["help", "shell", "theme"])
})

test("applySuggestionToInput preserves trailing args", () => {
  assert.equal(applySuggestionToInput("/he", "help"), "/help ")
  assert.equal(applySuggestionToInput("/he foo bar", "help"), "/help foo bar")
  assert.equal(applySuggestionToInput("plain", "help"), "plain")
})

test("normalizeSlashAlias expands known aliases", () => {
  assert.equal(normalizeSlashAlias("/h"), "/help")
  assert.equal(normalizeSlashAlias("/r"), "/resume")
  assert.equal(normalizeSlashAlias("/help"), "/help")
})
