import test from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"
import { validateTheme } from "../src/theme/schema.mjs"

test("default theme is valid", () => {
  const result = validateTheme(DEFAULT_THEME)
  assert.equal(result.valid, true)
  assert.equal(result.errors.length, 0)
})

test("theme validation rejects malformed color", () => {
  const input = structuredClone(DEFAULT_THEME)
  input.modes.agent = "green"
  const result = validateTheme(input)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((error) => error.includes("modes.agent")))
})
