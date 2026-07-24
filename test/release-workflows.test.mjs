import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

test("release workflow opts JavaScript actions into Node 24", async () => {
  const text = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")
  assert.match(text, /FORCE_JAVASCRIPT_ACTIONS_TO_NODE24:\s*true/)
})

test("release workflow publishes with the npm-release environment token", async () => {
  const text = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")
  assert.match(text, /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/)
  assert.match(text, /npm publish --access public --tag "\$DIST_TAG"/)
  assert.doesNotMatch(text, /id-token:\s*write/)
  assert.doesNotMatch(text, /npm publish[^\n]*--provenance/)
})

test("verify workflow opts JavaScript actions into Node 24", async () => {
  const text = await readFile(new URL("../.github/workflows/verify.yml", import.meta.url), "utf8")
  assert.match(text, /FORCE_JAVASCRIPT_ACTIONS_TO_NODE24:\s*true/)
})
